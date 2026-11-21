// Archivo, paso 9 (R19) y anexo C7 y C19: el original en Word, Excel,
// OpenDocument o RTF de una factura cuyo PDF ya está subido, desde su ficha
// del archivo. Se valida por el contenido, se guarda aparte y nunca se borra.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { blankPdf } from "./helpers/fixtures";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { attachOriginalDocumentAction, removeOriginalDocumentAction } from "@/app/dashboard/archivo/actions";
import { GET as archiveOriginal } from "@/app/api/archive/invoices/[id]/original/route";
import { loadArchiveInvoice } from "@/lib/archiveData";
import { verifyFirmAuditChains } from "@/lib/auditLog";
import { reseedDemo } from "@/lib/demoSeed";
import { ERROR_MESSAGES } from "@/lib/errorCodes";

const DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Un .doc mínimo (OLE2 con su flujo WordDocument), distinto en cada llamada. */
function wordDoc(tag = "uno"): Uint8Array {
  const container = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(container, "/WordDocument", Buffer.from(strToU8(tag)));
  return new Uint8Array(XLSX.CFB.write(container, { type: "buffer" }) as Buffer);
}

function wordDocx(text = "Factura"): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<Types><Override PartName="/word/document.xml" ContentType="${DOCX_MAIN}"/></Types>`),
    "word/document.xml": strToU8(`<w:document>${text}</w:document>`),
  });
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const attach = (invoiceId: string, bytes: Uint8Array, name: string) => {
  const form = new FormData();
  form.set("invoiceId", invoiceId);
  form.set("file", new File([new Uint8Array(bytes)], name));
  return attachOriginalDocumentAction(form);
};

const getOriginal = (id: string, query = "") =>
  archiveOriginal(new NextRequest(`http://x/api/archive/invoices/${id}/original${query}`), { params: Promise.resolve({ id }) });

const archiveRow = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });
const updatedAtOf = async (id: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).updatedAt;
const audits = (field: string, invoiceIds: string[]) =>
  prisma.auditLog.findMany({
    where: { field, invoiceId: { in: invoiceIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { invoiceId: true, userId: true, oldValue: true, newValue: true },
  });

/** Lo que no tiene que cambiar cuando se rechaza un adjunto. */
async function footprint(invoiceIds: string[]) {
  return {
    rows: await prisma.invoiceArchive.findMany({ where: { invoiceId: { in: invoiceIds } }, orderBy: { invoiceId: "asc" } }),
    documents: await prisma.document.count(),
    audits: await prisma.auditLog.count(),
    keys: fakeS3().keys().sort(),
  };
}

let a: FirmWorld;
let b: FirmWorld;
let pdf: Buffer;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
  pdf = await blankPdf(1);
  for (const inv of Object.values(a.invoices)) fakeS3().put(inv.storageKey, pdf);
  await prisma.invoiceArchive.updateMany({
    where: { invoiceId: { in: Object.values(a.invoices).map((inv) => inv.id) } },
    data: { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed" },
  });
});

describe("adjuntar el original en otro formato", () => {
  it("un .doc: crea el Document del cliente, guarda el objeto, pone ELECTRONIC/MANUAL y audita, sin tocar Invoice.updatedAt", async () => {
    const inv = a.invoices.validated;
    const before = await updatedAtOf(inv.id);
    const doc = wordDoc();
    signInAs(a.worker);
    expect(await attach(inv.id, doc, "Factura 7.doc")).toEqual({ ok: true, changed: 1 });

    const row = await archiveRow(inv.id);
    expect(row).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "other_format" });
    const document = await prisma.document.findUniqueOrThrow({ where: { id: row.originalDocumentId! } });
    expect(document).toMatchObject({
      clientId: a.client.id,
      filename: "Factura 7.doc",
      fileType: "application/msword",
      fileHash: sha256(doc),
      sizeBytes: doc.length,
      uploadedBy: a.worker.id,
    });
    // Anexo C19: bajo el prefijo del cliente, con instante y UUID.
    expect(document.storageKey).toMatch(new RegExp(`^${a.client.id}/originales/\\d+-[0-9a-f-]{36}-Factura_7\\.doc$`));
    expect(fakeS3().keys()).toContain(document.storageKey);

    expect(await audits("originalDocument", [inv.id])).toEqual([
      { invoiceId: inv.id, userId: a.worker.id, oldValue: null, newValue: "Factura 7.doc" },
    ]);
    expect(await audits("originalMedium", [inv.id])).toEqual([
      { invoiceId: inv.id, userId: a.worker.id, oldValue: null, newValue: "ELECTRONIC" },
    ]);
    expect(await updatedAtOf(inv.id)).toEqual(before);
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("el original se sirve como descarga (octet-stream) y ?copia=1 sirve el PDF", async () => {
    const inv = a.invoices.pending;
    const docx = wordDocx();
    signInAs(a.admin);
    expect(await attach(inv.id, docx, "Factura enero.docx")).toMatchObject({ ok: true });

    const original = await getOriginal(inv.id);
    expect(original.status).toBe(200);
    expect(original.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(original.headers.get("Content-Disposition")).toMatch(/^attachment;.*filename\*=UTF-8''Factura%20enero\.docx/);
    expect(Buffer.from(await original.arrayBuffer()).equals(Buffer.from(docx))).toBe(true);

    const copy = await getOriginal(inv.id, "?copia=1");
    expect(copy.headers.get("Content-Type")).toBe("application/pdf");
    expect(copy.headers.get("Content-Disposition")).toBe("inline");
    expect(Buffer.from(await copy.arrayBuffer()).equals(pdf)).toBe(true);

    const detail = await loadArchiveInvoice(inv.id, a.firm.id);
    expect(detail?.originalDocument).toMatchObject({ filename: "Factura enero.docx", fileType: DOCX_MIME, fromSplitRoot: false });
  });

  it("un fichero no admitido devuelve { error } sin tocar nada: ni Document, ni objeto, ni fila, ni auditoría", async () => {
    const inv = a.invoices.validated;
    signInAs(a.worker);
    const before = await footprint([inv.id]);
    const rejected = [
      [pdf, "factura.doc"],
      [wordDocx(), "factura.docm"],
      [zipSync({ "factura.pdf": new Uint8Array(pdf) }), "factura.docx"],
      [strToU8("MZ ejecutable"), "factura.doc"],
    ] as const;
    for (const [bytes, name] of rejected) {
      const res = await attach(inv.id, bytes, name);
      expect(res).toEqual({ error: expect.stringContaining(ERROR_MESSAGES["ERR-ARCHIVE-001"]) });
    }
    expect(await attach(inv.id, new Uint8Array(0), "vacio.doc")).toEqual({ error: "El fichero está vacío." });
    const form = new FormData();
    form.set("invoiceId", inv.id);
    expect(await attachOriginalDocumentAction(form)).toEqual({ error: "Elige el fichero del original." });
    expect(await footprint([inv.id])).toEqual(before);
  });

  it("adjuntar otro deja el anterior en el almacenamiento y en la auditoría", async () => {
    const inv = a.invoices.validated;
    signInAs(a.worker);
    await attach(inv.id, wordDoc(), "primero.doc");
    const first = (await archiveRow(inv.id)).originalDocumentId!;
    expect(await attach(inv.id, wordDocx(), "segundo.docx")).toEqual({ ok: true, changed: 1 });

    const second = (await archiveRow(inv.id)).originalDocumentId!;
    expect(second).not.toBe(first);
    const documents = await prisma.document.findMany({ where: { id: { in: [first, second] } } });
    expect(documents).toHaveLength(2);
    for (const document of documents) expect(fakeS3().keys()).toContain(document.storageKey);
    expect((await audits("originalDocument", [inv.id])).map((e) => [e.oldValue, e.newValue])).toEqual([
      [null, "primero.doc"],
      ["primero.doc", "segundo.docx"],
    ]);
    // El medio ya era electrónico a mano: solo la primera vez.
    expect(await audits("originalMedium", [inv.id])).toHaveLength(1);
  });

  it("mientras se analiza da error, y el objeto que se subió se borra", async () => {
    const inv = await makeInvoice(a.client, { status: "ANALYZING" });
    signInAs(a.worker);
    const before = await footprint([inv.id]);
    expect(await attach(inv.id, wordDoc(), "f.doc")).toEqual({ error: expect.stringMatching(/analizando/) });
    expect(await footprint([inv.id])).toEqual(before);
  });

  it("un gestor sin el cliente, otra asesoría o el portal reciben { error } y no se guarda nada", async () => {
    const inv = a.invoices.validated;
    const outsider = await makeUser(a.firm.id, "WORKER", "ajeno");
    const before = await footprint([inv.id]);
    for (const user of [outsider, b.admin, b.worker, a.clientUser]) {
      signInAs(user);
      expect(await attach(inv.id, wordDoc(), "f.doc")).toHaveProperty("error");
      expect(await removeOriginalDocumentAction({ invoiceId: inv.id })).toHaveProperty("error");
    }
    expect(await footprint([inv.id])).toEqual(before);
  });
});

describe("si falla la escritura en la BD", () => {
  // Fallo de verdad: un trigger que lanza al crear el Document.
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_adjunto_fallido() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fallo simulado al guardar el adjunto'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_adjunto_fallido ON "Document"`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_adjunto_fallido BEFORE INSERT ON "Document"
      FOR EACH ROW EXECUTE FUNCTION test_adjunto_fallido()`);
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_adjunto_fallido ON "Document"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_adjunto_fallido()`);
  });

  it("no queda ni Document ni fila cambiada, y el objeto recién subido se borra", async () => {
    const inv = a.invoices.validated;
    signInAs(a.worker);
    const before = await footprint([inv.id]);
    expect(await attach(inv.id, wordDoc(), "f.doc")).toEqual({ error: "No se ha podido guardar. Inténtalo de nuevo." });
    expect(await footprint([inv.id])).toEqual(before);
  });
});

describe("quitar el original adjunto (anexo C7)", () => {
  it("la fila deja de apuntarlo con auditoría «nombre → —», y no se borran ni el Document ni el objeto; el medio no cambia", async () => {
    const inv = a.invoices.validated;
    signInAs(a.worker);
    await attach(inv.id, wordDoc(), "equivocado.doc");
    const documentId = (await archiveRow(inv.id)).originalDocumentId!;
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    const before = await updatedAtOf(inv.id);

    expect(await removeOriginalDocumentAction({ invoiceId: inv.id })).toEqual({ ok: true, changed: 1 });
    expect(await archiveRow(inv.id)).toMatchObject({
      originalDocumentId: null,
      originalMedium: "ELECTRONIC",
      originalMediumSource: "MANUAL",
      // Ya no dice «Hay un original en otro formato adjunto».
      originalMediumReason: "manual",
    });
    expect(await prisma.document.findUnique({ where: { id: documentId } })).not.toBeNull();
    expect(fakeS3().keys()).toContain(document.storageKey);
    expect((await audits("originalDocument", [inv.id])).at(-1)).toEqual({
      invoiceId: inv.id, userId: a.worker.id, oldValue: "equivocado.doc", newValue: null,
    });
    expect(await updatedAtOf(inv.id)).toEqual(before);
    // El original vuelve a ser su PDF.
    expect((await getOriginal(inv.id)).headers.get("Content-Type")).toBe("application/pdf");
    // Otra vez: no tiene nada que quitar.
    expect(await removeOriginalDocumentAction({ invoiceId: inv.id })).toEqual({ error: expect.stringMatching(/ningún original adjunto/) });
  });
});

describe("en un documento dividido", () => {
  it("adjuntar desde una parte va a la raíz y vale para toda la familia; quitarlo desde otra parte lo quita de la raíz", async () => {
    const root = await makeInvoice(a.client, { status: "SPLIT_SOURCE", invoiceNumber: null });
    const p1 = await makeInvoice(a.client, { splitFromId: root.id, status: "PENDING_REVIEW" });
    const p2 = await makeInvoice(a.client, { splitFromId: root.id, status: "VALIDATED" });
    const family = [root.id, p1.id, p2.id];
    for (const id of family) {
      await prisma.invoiceArchive.update({
        where: { invoiceId: id },
        data: { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: id === root.id ? "scan_unconfirmed" : "split" },
      });
    }
    signInAs(a.worker);
    expect(await attach(p1.id, wordDocx(), "tickets.docx")).toEqual({ ok: true, changed: 3 });

    const rows = await prisma.invoiceArchive.findMany({ where: { invoiceId: { in: family } } });
    const rootRow = rows.find((r) => r.invoiceId === root.id)!;
    expect(rootRow.originalDocumentId).not.toBeNull();
    expect(rows.filter((r) => r.invoiceId !== root.id).map((r) => r.originalDocumentId)).toEqual([null, null]);
    for (const row of rows) {
      expect(row).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "other_format" });
    }
    expect((await audits("originalDocument", family)).map((e) => e.invoiceId).sort()).toEqual([...family].sort());
    expect((await audits("originalMedium", family)).map((e) => e.invoiceId).sort()).toEqual([...family].sort());
    // La otra parte sirve el Word de la familia.
    expect((await getOriginal(p2.id)).headers.get("Content-Type")).toBe("application/octet-stream");
    expect((await loadArchiveInvoice(p2.id, a.firm.id))?.originalDocument).toMatchObject({ filename: "tickets.docx", fromSplitRoot: true });

    expect(await removeOriginalDocumentAction({ invoiceId: p2.id })).toEqual({ ok: true, changed: 3 });
    expect((await archiveRow(root.id)).originalDocumentId).toBeNull();
    expect((await audits("originalDocument", family)).filter((e) => e.newValue === null).map((e) => e.invoiceId).sort())
      .toEqual([...family].sort());
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });
});

describe("el reset de la demo (anexo C19)", () => {
  it("se lleva el adjunto: su clave va bajo el prefijo del cliente y su Document se borra después de la factura", async () => {
    const demo = await makeFirm("D", { demo: true });
    fakeS3().put(demo.invoices.validated.storageKey, pdf);
    signInAs(demo.worker);
    expect(await attach(demo.invoices.validated.id, wordDoc(), "demo.doc")).toMatchObject({ ok: true });
    const key = (await prisma.document.findFirstOrThrow({ where: { filename: "demo.doc" } })).storageKey;
    expect(fakeS3().keys()).toContain(key);

    expect((await reseedDemo(demo.firm.id, demo.admin.id)).ok).toBe(true);
    expect(fakeS3().keys()).not.toContain(key);
    expect(await prisma.document.count({ where: { filename: "demo.doc" } })).toBe(0);
  });
});
