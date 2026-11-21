// Electrónico o papel al analizar (paso 4, R10 y R11 con el anexo C2 y C18):
// processInvoice real, con el OCR simulado y PDF de verdad en el S3 falso, para
// que la capa de texto y el productor salgan de pdfjs.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Invoice } from "@prisma/client";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { facturaeXml, PNG_DATA_URL } from "./helpers/fixtures";
import { stubOcr } from "./helpers/ocr";
import { inFlight } from "./helpers/inflight";
import { DIGITAL_PRODUCER, digitalPdf, imageOnlyPdf, SCANNER_PRODUCER, scannerPdf, testPdf } from "./helpers/pdfs";
import { processInvoice } from "@/lib/processInvoice";
import { applyAutoMedium } from "@/lib/archiveEdits";
import { OcrHttpError } from "@/lib/ocrErrors";
import { formatAuditValue } from "@/lib/invoiceStatuses";
import type { ExtractedInvoice, OcrResult } from "@/lib/ocr";

let w: FirmWorld;

const reply = (): OcrResult => ({
  rawJson: "{}",
  extracted: {
    issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: w.client.name, receiverCif: w.client.cif,
    invoiceNumber: "F-1", invoiceDate: "2026-09-10", taxBase: 100, vatRate: 21, vatAmount: 21,
    irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
    vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
  } as ExtractedInvoice,
});

beforeEach(async () => {
  w = await makeFirm("A");
  stubOcr(async () => reply());
});

let sequence = 0;
/** Sube `body` al S3 falso y da de alta la factura en UPLOADED, como /api/uploads. */
async function upload(body: Buffer | string, fileType = "application/pdf", extra: Partial<Invoice> = {}): Promise<Invoice> {
  const key = `${w.client.id}/2026-09/archivo-${++sequence}`;
  fakeS3().put(key, body);
  return makeInvoice(w.client, {
    filename: fileType.includes("xml") ? `f${sequence}.xml` : fileType.startsWith("image/") ? `f${sequence}.png` : `f${sequence}.pdf`,
    storageKey: key, fileType, status: "UPLOADED",
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
    ...extra,
  });
}

const archive = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({
  where: { invoiceId },
  select: { originalMedium: true, originalMediumSource: true, originalMediumReason: true, pdfProducer: true, paperHeldByClient: true },
});
const mediumAudit = async (invoiceId: string) =>
  (await prisma.auditLog.findMany({ where: { invoiceId, field: { in: ["auto:originalMedium", "originalMedium"] } }, orderBy: { createdAt: "asc" } }))
    .map((e) => [e.field, e.oldValue, e.newValue]);

/** Vuelve a analizar (lo que hace Reprocesar: a UPLOADED y otra vez). */
async function reprocess(invoiceId: string) {
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "UPLOADED" } });
  await processInvoice(invoiceId, w.worker.id);
}

describe("la propuesta al analizar (R10 con el anexo C2)", () => {
  it("PDF con texto de un programa: electrónico automático, con su productor, y sin auditoría (primera propuesta)", async () => {
    const invoice = await upload(await digitalPdf());
    await processInvoice(invoice.id, w.worker.id);
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status);
    expect(await archive(invoice.id)).toEqual({
      originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text",
      pdfProducer: DIGITAL_PRODUCER, paperHeldByClient: false,
    });
    expect(await mediumAudit(invoice.id)).toEqual([]);
  });

  it("PDF sin capa de texto (solo una imagen): por confirmar, escaneo", async () => {
    const invoice = await upload(await imageOnlyPdf());
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({
      originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed", pdfProducer: "Mi app de fotos",
    });
  });

  it("PDF de escáner aunque lleve capa de texto: por confirmar, con el productor del escáner; el papel no se da por guardado", async () => {
    const invoice = await upload(await scannerPdf());
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toEqual({
      originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed",
      pdfProducer: SCANNER_PRODUCER, paperHeldByClient: false,
    });
  });

  it("XML (Facturae): electrónico, sin pasar por el OCR", async () => {
    const invoice = await upload(facturaeXml({ buyerCif: w.client.cif, buyerName: w.client.name }), "application/xml");
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "xml", pdfProducer: null });
  });

  it("una foto: por confirmar", async () => {
    const invoice = await upload(Buffer.from(PNG_DATA_URL.split(",")[1], "base64"), "image/png");
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "image_unconfirmed" });
  });

  it("un PDF que no se puede leer: por confirmar, «No se pudo leer el PDF»", async () => {
    const invoice = await upload("%PDF-1.4 roto");
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "pdf_unreadable" });
  });

  it("un NUL en el productor del PDF no tumba el análisis: el productor se guarda limpio", async () => {
    // Postgres no admite NUL en un texto (22021): antes se deshacía todo el OCR
    // y la factura se quedaba en ANALYZING.
    const invoice = await upload(await testPdf({ text: true, producer: "Microsoft Word\u0000" }));
    await processInvoice(invoice.id, w.worker.id);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(after.status);
    expect(after.lastOcrError).toBeNull();
    expect(await archive(invoice.id)).toMatchObject({
      originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: "Microsoft Word",
    });
  });
});

describe("dentro de las transacciones valladas del análisis", () => {
  it("con ERR-OCR (el OCR falla) el medio queda escrito igual", async () => {
    stubOcr(async () => { throw new OcrHttpError("Gemini Flash respondió 400: invalid argument", 400, null); });
    const invoice = await upload(await digitalPdf());
    await processInvoice(invoice.id, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("OCR_ERROR");
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });
  });

  it("si falla la escritura del medio, el resultado del OCR y el OCR_ERROR se guardan igual", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_archivo_medio_falla() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'fallo de prueba del archivo'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_archivo_medio_falla BEFORE UPDATE ON "InvoiceArchive"
      FOR EACH ROW EXECUTE FUNCTION test_archivo_medio_falla()`);
    try {
      const ok = await upload(await digitalPdf());
      await processInvoice(ok.id, w.worker.id);
      const after = await prisma.invoice.findUniqueOrThrow({ where: { id: ok.id } });
      expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(after.status);
      expect(after.invoiceNumber).toBe("F-1");
      expect(await archive(ok.id)).toMatchObject({ originalMedium: null, originalMediumSource: null, originalMediumReason: null });

      stubOcr(async () => { throw new OcrHttpError("Gemini Flash respondió 400: invalid argument", 400, null); });
      const failed = await upload(await digitalPdf());
      await processInvoice(failed.id, w.worker.id);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("OCR_ERROR");
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_archivo_medio_falla ON "InvoiceArchive"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_archivo_medio_falla()`);
    }
  });

  it("si el PDF no se llega a descargar, no se propone nada: no hay de qué", async () => {
    const invoice = await upload(await digitalPdf());
    fakeS3().setMode("down");
    await processInvoice(invoice.id, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("OCR_ERROR");
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: null, originalMediumReason: null });
  });

  it("con la valla ocrAttempts cambiada (el cron la relanzó) la ejecución vieja no escribe el medio", async () => {
    const invoice = await upload(await digitalPdf());
    fakeS3().setMode("hold");
    const run = inFlight(processInvoice(invoice.id, w.worker.id));
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    // Otro claim: la ejecución en curso ya no es la dueña.
    await prisma.invoice.updateMany({ where: { id: invoice.id }, data: { ocrAttempts: { increment: 1 } } });
    fakeS3().releaseGets();
    await run;
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: null, originalMediumReason: null });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("ANALYZING");
  });

  it("lee el PDF una sola vez aunque Gemini se reintente", async () => {
    const ocrLlm = await import("@/lib/ocrLlm");
    const read = vi.spyOn(ocrLlm, "extractPdfTextAndItems");
    let calls = 0;
    stubOcr(async () => {
      if (++calls === 1) throw new OcrHttpError("Gemini Flash respondió 500: backend error", 500, 0);
      return reply();
    });
    try {
      const invoice = await upload(await digitalPdf());
      await processInvoice(invoice.id, w.worker.id);
      expect(calls).toBe(2);
      expect(read).toHaveBeenCalledTimes(1);
      expect(await archive(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
    } finally {
      read.mockRestore();
    }
  });
});

describe("quién manda en el medio (R11)", () => {
  it("no pisa un taco", async () => {
    const taco = await prisma.uploadBatch.create({
      data: { advisoryFirmId: w.firm.id, clientId: w.client.id, createdById: w.worker.id, fileCount: 1, periodType: "MONTHLY", periodMonth: 9, periodYear: 2026, invoiceType: "PURCHASE", tacoNumber: 37 },
    });
    const invoice = await upload(await digitalPdf());
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { uploadBatchId: taco.id, uploadPosition: 1, originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" },
    });
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco", pdfProducer: null });
  });

  it("no pisa lo que ha puesto una persona", async () => {
    // Si el updateMany no mirase el origen, este PDF digital lo pasaría a electrónico.
    const invoice = await upload(await digitalPdf());
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual", pdfProducer: null });
    expect(await mediumAudit(invoice.id)).toEqual([]);
  });

  it("no escribe en una parte de una división: hereda de su original", async () => {
    const root = await upload(await scannerPdf(), "application/pdf", { status: "SPLIT_SOURCE" });
    await prisma.invoiceArchive.update({
      where: { invoiceId: root.id },
      data: { originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed", pdfProducer: SCANNER_PRODUCER },
    });
    // La parte es un PDF que hizo la app al dividir: su productor no dice nada.
    const part = await upload(await digitalPdf(), "application/pdf", { splitFromId: root.id });
    await prisma.invoiceArchive.update({
      where: { invoiceId: part.id },
      data: { originalMediumSource: "AUTO", originalMediumReason: "split", pdfProducer: SCANNER_PRODUCER, splitPart: 1 },
    });
    await processInvoice(part.id, w.worker.id);
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain((await prisma.invoice.findUniqueOrThrow({ where: { id: part.id } })).status);
    expect(await archive(part.id)).toMatchObject({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "split", pdfProducer: SCANNER_PRODUCER });
  });

  it("un reproceso que le da la vuelta al medio deja auto:originalMedium; uno que no lo cambia, no", async () => {
    const invoice = await upload(await digitalPdf());
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });

    fakeS3().put(invoice.storageKey, await scannerPdf());
    await reprocess(invoice.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed", pdfProducer: SCANNER_PRODUCER });
    const entries = await mediumAudit(invoice.id);
    expect(entries).toEqual([["auto:originalMedium", "ELECTRONIC", null]]);
    expect(formatAuditValue(entries[0][1], "auto:originalMedium")).toBe("Electrónico");
    expect(formatAuditValue(entries[0][2], "auto:originalMedium")).toBe("Por confirmar");

    // Otro escaneo: sigue por confirmar, sin entrada nueva.
    fakeS3().put(invoice.storageKey, await imageOnlyPdf());
    await reprocess(invoice.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumReason: "scan_unconfirmed", pdfProducer: "Mi app de fotos" });
    expect(await mediumAudit(invoice.id)).toHaveLength(1);
  });

  it("un reproceso que no consigue leer el PDF (roto o cortado por tiempo) no pisa un medio ya leído", async () => {
    const invoice = await upload(await digitalPdf());
    await processInvoice(invoice.id, w.worker.id);
    const read = { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: DIGITAL_PRODUCER };
    expect(await archive(invoice.id)).toMatchObject(read);

    fakeS3().put(invoice.storageKey, "%PDF-1.4 roto");
    await reprocess(invoice.id);
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status);
    expect(await archive(invoice.id)).toMatchObject(read);

    const timedOut = { text: "", timedOut: true, producer: "Microsoft Word" };
    const audit = await prisma.$transaction((tx) =>
      applyAutoMedium(tx, { invoiceId: invoice.id, fileType: "application/pdf", pdf: timedOut, userId: w.worker.id }));
    expect(audit).toEqual([]);
    expect(await archive(invoice.id)).toMatchObject(read);
    expect(await mediumAudit(invoice.id)).toEqual([]);

    // Sin una lectura buena que conservar, sí: «No se pudo leer el PDF».
    await prisma.invoiceArchive.update({ where: { invoiceId: invoice.id }, data: { originalMedium: null, originalMediumReason: "backfill_pending" } });
    await prisma.$transaction((tx) =>
      applyAutoMedium(tx, { invoiceId: invoice.id, fileType: "application/pdf", pdf: timedOut, userId: w.worker.id }));
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "pdf_unreadable" });
  });

  it("un PDF antiguo pendiente de detectar que se reprocesa: es su primera propuesta, sin auditoría", async () => {
    const invoice = await upload(await digitalPdf());
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { originalMediumSource: "AUTO", originalMediumReason: "backfill_pending" },
    });
    await processInvoice(invoice.id, w.worker.id);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });
    expect(await mediumAudit(invoice.id)).toEqual([]);
  });
});

describe("partes de una división (anexo C18)", () => {
  /** Original dividida en dos partes, todas en automático y por confirmar. */
  async function family() {
    const root = await makeInvoice(w.client, { status: "SPLIT_SOURCE" });
    const parts = [
      await makeInvoice(w.client, { splitFromId: root.id }),
      await makeInvoice(w.client, { splitFromId: root.id }),
    ];
    // Una parte que se volvió a dividir: también es de la familia.
    const grandchild = await makeInvoice(w.client, { splitFromId: parts[1].id });
    const all = [root, ...parts, grandchild];
    for (const [i, inv] of all.entries()) {
      await prisma.invoiceArchive.update({
        where: { invoiceId: inv.id },
        data: { originalMediumSource: "AUTO", originalMediumReason: i === 0 ? "pdf_unreadable" : "split", splitPart: i },
      });
    }
    return { root, others: [...parts, grandchild] };
  }
  const textReading = { text: "Factura con texto de sobra para ser una capa de texto de verdad. ".repeat(4), producer: "Facturador 3000" };

  it("la propuesta de la original llega a todas sus partes si toda la familia está vacía o en automático", async () => {
    const { root, others } = await family();
    const audit = await prisma.$transaction((tx) =>
      applyAutoMedium(tx, { invoiceId: root.id, fileType: "application/pdf", pdf: textReading, userId: w.worker.id }));
    expect(await archive(root.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: "Facturador 3000" });
    for (const part of others) {
      expect(await archive(part.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "split", pdfProducer: "Facturador 3000" });
    }
    // Le dan la vuelta a «Por confirmar» que ya había propuesto la app: queda en cada una.
    expect(audit.map((e) => [e.invoiceId, e.field, e.oldValue, e.newValue]).sort()).toEqual(
      [root, ...others].map((inv) => [inv.id, "auto:originalMedium", null, "ELECTRONIC"]).sort(),
    );
  });

  it("con una parte puesta a mano, la propuesta se queda en la original y no baja a las partes", async () => {
    const { root, others } = await family();
    await prisma.invoiceArchive.update({
      where: { invoiceId: others[0].id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });
    await prisma.$transaction((tx) =>
      applyAutoMedium(tx, { invoiceId: root.id, fileType: "application/pdf", pdf: textReading, userId: w.worker.id }));
    expect(await archive(root.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
    expect(await archive(others[0].id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL" });
    expect(await archive(others[1].id)).toMatchObject({ originalMedium: null, originalMediumReason: "split" });
  });

  it("sobre una parte no hace nada", async () => {
    const { others } = await family();
    const audit = await prisma.$transaction((tx) =>
      applyAutoMedium(tx, { invoiceId: others[0].id, fileType: "application/pdf", pdf: textReading, userId: w.worker.id }));
    expect(audit).toEqual([]);
    expect(await archive(others[0].id)).toMatchObject({ originalMedium: null, originalMediumReason: "split" });
  });
});
