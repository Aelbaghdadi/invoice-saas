// Separacion automatica de un taco al analizarlo (autoSplit.ts): varias
// facturas en un PDF, con paginas en blanco o albaranes por medio.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf } from "./helpers/fixtures";
import { stubOcr, stubPages } from "./helpers/ocr";
import { processInvoice } from "@/lib/processInvoice";
import { getObjectBytes } from "@/lib/storage";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { isValidNIF } from "@/lib/validators";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { PageReading } from "@/lib/pdfSegmentation";

let w: FirmWorld;

const factura = (page: number, invoiceNumber: string, startsInvoice: boolean): PageReading =>
  ({ page, kind: "FACTURA", startsInvoice, invoiceNumber, issuerCif: "B12345674" });
const enBlanco = (page: number): PageReading =>
  ({ page, kind: "EN_BLANCO", startsInvoice: false, invoiceNumber: null, issuerCif: null });

/** OCR de cada hija: una compra distinta por llamada (otro importe que las de makeFirm: si no, posibles duplicados). */
function stubInvoices(receiverCifs: () => string) {
  let n = 0;
  stubOcr(async () => {
    n++;
    return {
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: null, receiverCif: receiverCifs(),
        invoiceNumber: `T-${n}`, invoiceDate: "2026-09-10", taxBase: 1000 * n, vatRate: 21, vatAmount: 210 * n,
        irpfRate: null, irpfAmount: null, totalAmount: 1210 * n, currency: "EUR",
        vatLines: [{ taxBase: 1000 * n, vatRate: 21, vatAmount: 210 * n }], confidence: null,
      } as ExtractedInvoice,
    };
  });
}

async function uploadPdf(pages: number, overrides: Parameters<typeof makeInvoice>[1] = {}) {
  const key = `k-${Math.random()}`;
  fakeS3().put(key, await blankPdf(pages));
  return makeInvoice(w.client, {
    filename: "taco.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED",
    invoiceNumber: null, issuerCif: null, totalAmount: null,
    ...overrides,
  });
}

const childrenOf = (id: string) => prisma.invoice.findMany({ where: { splitFromId: id }, orderBy: { filename: "asc" } });
const pageCount = async (storageKey: string) => {
  const { PDFDocument } = await import("pdf-lib");
  return (await PDFDocument.load(await getObjectBytes(storageKey))).getPageCount();
};

beforeEach(async () => {
  w = await makeFirm("A");
});

describe("separación automática de un taco", () => {
  it("separa las facturas, descarta la página en blanco y analiza cada hija", async () => {
    let classified = 0;
    stubPages(async () => {
      classified++;
      return [factura(1, "F-1", true), enBlanco(2), factura(3, "F-2", true), factura(4, "F-2", false)];
    });
    stubInvoices(() => w.client.cif);
    const { id } = await uploadPdf(4);

    await processInvoice(id, w.worker.id);

    const parent = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(parent.status).toBe("SPLIT_SOURCE");
    const children = await childrenOf(id);
    expect(children.map((c) => c.filename)).toEqual(["taco (factura 1 de 2).pdf", "taco (factura 2 de 2).pdf"]);
    expect(await Promise.all(children.map((c) => pageCount(c.storageKey)))).toEqual([1, 2]);
    expect(children.map((c) => c.status)).toEqual(["PENDING_REVIEW", "PENDING_REVIEW"]);
    // Las hijas no se vuelven a clasificar.
    expect(classified).toBe(1);

    const history = await prisma.invoiceStatusHistory.findMany({ where: { invoiceId: id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual(["UPLOADED->ANALYZING", "ANALYZING->SPLIT_SOURCE"]);
    const audit = await prisma.auditLog.findMany({
      where: { invoiceId: id, field: { in: ["status", "auto:division"] } },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => [a.field, a.oldValue, a.newValue])).toEqual([
      ["status", "ANALYZING", "SPLIT_SOURCE"],
      ["auto:division", "4 páginas", "2 facturas · descartadas: p. 2 (en blanco)"],
    ]);
  });

  it("las partes heredan el archivo de la original: nº de parte y el mismo medio", async () => {
    stubPages(async () => [factura(1, "F-1", true), factura(2, "F-2", true)]);
    stubInvoices(() => w.client.cif);
    const { id } = await uploadPdf(2);

    await processInvoice(id, w.worker.id);

    const parentArchive = await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } });
    const children = await childrenOf(id);
    const archives = await prisma.invoiceArchive.findMany({
      where: { invoiceId: { in: children.map((c) => c.id) } },
      orderBy: { splitPart: "asc" },
    });
    expect(archives.map((a) => a.splitPart)).toEqual([1, 2]);
    expect(parentArchive.originalMediumReason).not.toBeNull();
    expect(archives.map((a) => a.originalMedium)).toEqual([parentArchive.originalMedium, parentArchive.originalMedium]);
  });

  it("una factura de varias páginas no se toca", async () => {
    stubPages(async () => [factura(1, "F-1", true), factura(2, "F-1", false)]);
    stubInvoices(() => w.client.cif);
    const { id } = await uploadPdf(2);

    await processInvoice(id, w.worker.id);

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_REVIEW");
    expect(await childrenOf(id)).toEqual([]);
  });

  it("si la clasificación falla, el PDF se analiza entero", async () => {
    stubPages(async () => { throw new Error("Gemini 503"); });
    stubInvoices(() => w.client.cif);
    const { id } = await uploadPdf(3);

    await processInvoice(id, w.worker.id);

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_REVIEW");
    expect(await childrenOf(id)).toEqual([]);
  });

  it("un taco subido para clasificar: cada hija va a su cliente", async () => {
    const validCif = (digits: string) => [..."0123456789ABCDEFGHIJ"].map((c) => `B${digits}${c}`).find(isValidNIF)!;
    const a = await prisma.client.update({ where: { id: w.client.id }, data: { cif: validCif("1111111") } });
    const b = await prisma.client.create({
      data: { name: "Empresa B SL", cif: validCif("2222222"), email: "b@pruebas.es", advisoryFirmId: w.firm.id },
    });
    const bucket = await getOrCreateUnclassifiedClient(w.firm.id);
    stubPages(async () => [factura(1, "F-1", true), factura(2, "F-2", true)]);
    const cifs = [a.cif, b.cif];
    stubInvoices(() => cifs.shift()!);
    const key = `k-${Math.random()}`;
    fakeS3().put(key, await blankPdf(2));
    const { id } = await makeInvoice(bucket, {
      filename: "taco.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED",
      invoiceNumber: null, issuerCif: null, totalAmount: null, routingCandidateIds: [a.id, b.id],
    });

    await processInvoice(id, w.worker.id);

    const children = await childrenOf(id);
    expect(children.map((c) => c.clientId).sort()).toEqual([a.id, b.id].sort());
    expect(children.map((c) => c.status)).toEqual(["PENDING_REVIEW", "PENDING_REVIEW"]);
  });
});
