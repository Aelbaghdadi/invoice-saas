// Altas con la fila de archivo completa y claves únicas en el almacenamiento
// (archivo, paso 5). /api/uploads crea Document, Invoice y la fila de archivo
// en una sola transacción; si falla, no queda nada y el fichero se borra.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, type FirmWorld } from "./helpers/factories";
import { blankPdf, facturaeXml, PNG_DATA_URL } from "./helpers/fixtures";
import { signInAs, type TestSessionUser } from "./helpers/session";
import { discardAfterCallbacks } from "./helpers/after";
import { inFlight } from "./helpers/inflight";
import { POST as upload } from "@/app/api/uploads/route";
import { flushUploadNotices } from "@/lib/uploadNotices";
import { getObjectBytes } from "@/lib/storage";

let w: FirmWorld;

beforeEach(async () => {
  w = await makeFirm("A");
});

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const sha256 = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pngBytes = () => Buffer.from(PNG_DATA_URL.split(",")[1], "base64");

async function pdfBytes(marker: string): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setTitle(marker);
  return Buffer.from(await doc.save());
}

/** POST /api/uploads como `user`, al lote de abril de 2026 del cliente de A. */
async function post(user: TestSessionUser, name: string, bytes: Buffer, type: string) {
  signInAs(user);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  form.set("clientId", w.client.id);
  form.set("periodType", "MONTHLY");
  form.set("periodMonth", "4");
  form.set("periodYear", "2026");
  form.set("type", "PURCHASE");
  const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
  // El análisis va en un after(): aquí solo interesa el alta.
  discardAfterCallbacks();
  return { status: res.status, body: await res.json() };
}

const invoiceWithArchive = (id: string) =>
  prisma.invoice.findUniqueOrThrow({ where: { id }, include: { archive: true, document: true } });

describe("POST /api/uploads deja la fila de archivo como toca", () => {
  it("un XML es electrónico, una imagen queda «Por confirmar» y un PDF espera al análisis", async () => {
    const xml = await post(w.worker, "factura.xml", Buffer.from(facturaeXml()), "application/xml");
    const png = await post(w.worker, "foto.png", pngBytes(), "image/png");
    const pdf = await post(w.worker, "escaneo.pdf", await blankPdf(1), "application/pdf");
    for (const r of [xml, png, pdf]) expect(r.status).toBe(200);

    const expected = {
      [xml.body.invoiceId]: { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "xml" },
      [png.body.invoiceId]: { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "image_unconfirmed" },
      [pdf.body.invoiceId]: { originalMedium: null, originalMediumSource: null, originalMediumReason: null },
    };
    for (const [id, medium] of Object.entries(expected)) {
      const invoice = await invoiceWithArchive(id);
      expect(invoice.archive).toMatchObject({
        ...medium,
        receivedAt: invoice.createdAt,
        uploadBatchId: null,
        uploadPosition: null,
        splitPart: 0,
        paperHeldByClient: false,
        registerNumber: null,
      });
    }
  });

  it("lo que sube el cliente desde su portal lo guarda él", async () => {
    const r = await post(w.clientUser, "ticket.pdf", await blankPdf(1), "application/pdf");
    await flushUploadNotices();
    expect(r.status).toBe(200);
    expect((await invoiceWithArchive(r.body.invoiceId)).archive).toMatchObject({ paperHeldByClient: true, originalMedium: null });
  });

  it("la clave lleva el cliente, el periodo, el instante y un UUID, y Document e Invoice apuntan al mismo objeto", async () => {
    const bytes = await pdfBytes("uno");
    const r = await post(w.worker, "Factura Abril.pdf", bytes, "application/pdf");
    const invoice = await invoiceWithArchive(r.body.invoiceId);
    expect(invoice.storageKey).toMatch(new RegExp(`^${w.client.id}/2026-04/\\d+-${UUID}-Factura_Abril\\.pdf$`));
    expect(invoice.document?.storageKey).toBe(invoice.storageKey);
    expect(fakeS3().keys()).toEqual([invoice.storageKey]);
  });

  it("dos subidas a la vez con el mismo nombre: dos objetos, y cada factura con el suyo", async () => {
    const [a, b] = [await pdfBytes("primera"), await pdfBytes("segunda")];
    const [ra, rb] = await Promise.all([
      inFlight(post(w.worker, "scan.pdf", a, "application/pdf")),
      inFlight(post(w.worker, "scan.pdf", b, "application/pdf")),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const invoices = await Promise.all([ra, rb].map((r) => invoiceWithArchive(r.body.invoiceId)));
    expect(new Set(invoices.map((i) => i.storageKey)).size).toBe(2);
    expect(fakeS3().keys().sort()).toEqual(invoices.map((i) => i.storageKey).sort());
    // Cada objeto es el fichero de su factura: nadie sobrescribió al otro.
    for (const invoice of invoices) expect(sha256(await getObjectBytes(invoice.storageKey))).toBe(invoice.fileHash);
    expect(new Set(invoices.map((i) => i.fileHash))).toEqual(new Set([sha256(a), sha256(b)]));
  });
});

describe("si el alta falla, no queda nada", () => {
  // Fallo de verdad en la BD: un trigger que lanza al insertar la factura
  // (después de crear el Document, en la misma transacción).
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_alta_fallida() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fallo simulado al dar de alta la factura'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_alta_fallida ON "Invoice"`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_alta_fallida BEFORE INSERT ON "Invoice"
      FOR EACH ROW EXECUTE FUNCTION test_alta_fallida()`);
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_alta_fallida ON "Invoice"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_alta_fallida()`);
  });

  it("ni Document ni Invoice, el objeto se borra, ERR-SYS-001 y un ticket automático", async () => {
    const before = { documents: await prisma.document.count(), invoices: await prisma.invoice.count() };
    const r = await post(w.worker, "falla.pdf", await blankPdf(1), "application/pdf");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("ERR-SYS-001");
    expect(await prisma.document.count()).toBe(before.documents);
    expect(await prisma.invoice.count()).toBe(before.invoices);
    expect(fakeS3().keys()).toEqual([]);
    const ticket = await prisma.supportTicket.findFirstOrThrow({ where: { source: "AUTO" } });
    expect(ticket.pageUrl).toBe("/api/uploads");
  });
});
