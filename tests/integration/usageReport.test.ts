// F-043: informe de uso por asesoría, con lo que ya hay en la BD.
import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice } from "./helpers/factories";
import { usageReport } from "@/lib/usageReport";
import { fakeS3 } from "./helpers/fakeS3";
import { stubOcr } from "./helpers/ocr";
import { processInvoice } from "@/lib/processInvoice";
import type { ExtractedInvoice } from "@/lib/ocr";

describe("informe de uso (F-043)", () => {
  it("cuadra con lo sembrado, por mes de Madrid, y no cuenta otra asesoría", async () => {
    const now = new Date("2026-09-30T10:00:00Z");
    const a = await makeFirm("A");
    // makeFirm deja dos facturas, un cliente, admin, gestor y usuario del
    // portal, creados ahora: fuera de estos meses. Se llevan a octubre.
    await prisma.invoice.updateMany({ where: { clientId: a.client.id }, data: { createdAt: new Date("2026-10-15T10:00:00Z") } });
    await prisma.client.update({ where: { id: a.client.id }, data: { createdAt: new Date("2026-08-10T10:00:00Z") } });
    await prisma.user.updateMany({ where: { id: { in: [a.admin.id, a.worker.id, a.clientUser.id] } }, data: { createdAt: new Date("2026-08-10T10:00:00Z") } });

    const at = (iso: string) => ({ createdAt: new Date(iso) });
    // Subidas: una el 1 de septiembre a las 00:30 en Madrid (31 de agosto en
    // UTC), otra en agosto, y la hija de una división, que no cuenta.
    const sep = await makeInvoice(a.client, at("2026-08-31T22:30:00Z"));
    const aug = await makeInvoice(a.client, at("2026-08-20T10:00:00Z"));
    await makeInvoice(a.client, { ...at("2026-09-05T10:00:00Z"), splitFromId: sep.id });
    // OCR: dos en septiembre (una reproceso), un XML en agosto, un fallo en septiembre.
    const extraction = (invoiceId: string, source: string, iso: string, isReprocess = false) =>
      prisma.invoiceExtraction.create({ data: { invoiceId, source, isReprocess, ...at(iso) } });
    await extraction(sep.id, "gemini_multimodal", "2026-09-02T10:00:00Z");
    await extraction(sep.id, "gemini_multimodal", "2026-09-03T10:00:00Z", true);
    await extraction(aug.id, "xml_parse", "2026-08-21T10:00:00Z");
    const history = (invoiceId: string, fromStatus: string | null, toStatus: string, iso: string) =>
      prisma.invoiceStatusHistory.create({ data: { invoiceId, fromStatus: fromStatus as never, toStatus: toStatus as never, ...at(iso) } });
    await history(aug.id, "ANALYZING", "OCR_ERROR", "2026-09-04T10:00:00Z");
    // Validadas: la misma dos veces en septiembre cuenta una; otra en agosto.
    await history(sep.id, "PENDING_REVIEW", "VALIDATED", "2026-09-06T10:00:00Z");
    await history(sep.id, "PENDING_REVIEW", "VALIDATED", "2026-09-07T10:00:00Z");
    await history(aug.id, "PENDING_REVIEW", "VALIDATED", "2026-08-25T10:00:00Z");
    // Exportadas: las dos en septiembre, una de ellas en dos lotes.
    for (const id of [sep.id, aug.id, sep.id]) {
      const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: a.admin.id } });
      await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: id, snapshot: "{}", ...at("2026-09-10T10:00:00Z") } });
    }
    // Un cliente nuevo en septiembre.
    await prisma.client.create({ data: { name: "Nuevo SL", cif: "B77777777", advisoryFirmId: a.firm.id, ...at("2026-09-12T10:00:00Z") } });

    // Lo mismo en otra asesoría, que no se puede colar.
    const b = await makeFirm("B");
    const other = await makeInvoice(b.client, at("2026-09-02T10:00:00Z"));
    await extraction(other.id, "gemini_multimodal", "2026-09-02T10:00:00Z");
    await history(other.id, "PENDING_REVIEW", "VALIDATED", "2026-09-06T10:00:00Z");

    const report = await usageReport(a.firm.id, now, 3);
    expect(report.map((m) => m.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(report[0]).toEqual({
      month: "2026-09", uploaded: 1, ocrAnalyses: 3, ocrReprocesses: 1, ocrFailures: 1, xmlParsed: 0,
      validated: 1, exported: 2, clients: 2, staffUsers: 2, portalUsers: 1,
    });
    expect(report[1]).toEqual({
      month: "2026-08", uploaded: 1, ocrAnalyses: 0, ocrReprocesses: 0, ocrFailures: 0, xmlParsed: 1,
      validated: 1, exported: 0, clients: 1, staffUsers: 2, portalUsers: 1,
    });
    expect(report[2]).toMatchObject({ month: "2026-07", uploaded: 0, clients: 0, staffUsers: 0, portalUsers: 0 });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("con processInvoice de verdad: un PDF leído por Gemini por texto cuenta como análisis de OCR", async () => {
    // Con clave, un PDF va por extractPdfWithGemini (simulado: «gemini_text»).
    vi.stubEnv("GEMINI_API_KEY", "clave-de-prueba");
    const a = await makeFirm("A");
    const upload = async (key: string) => {
      fakeS3().put(key, "%PDF-1.4");
      return (await makeInvoice(a.client, { storageKey: key, fileType: "application/pdf", status: "UPLOADED", invoiceNumber: null, totalAmount: null })).id;
    };
    const ok = await upload("k-uso-1");
    stubOcr(async () => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: a.client.name, receiverCif: a.client.cif,
        invoiceNumber: "U-1", invoiceDate: "2026-09-10", taxBase: 100, vatRate: 21, vatAmount: 21,
        irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
      } as ExtractedInvoice,
    }));
    await processInvoice(ok, a.worker.id);
    expect((await prisma.invoiceExtraction.findFirstOrThrow({ where: { invoiceId: ok } })).source).toBe("gemini_text");
    // Otra que falla sin remedio (PDF ilegible): análisis, y fallido.
    const bad = await upload("k-uso-2");
    stubOcr(async () => { throw new Error("Invalid PDF structure"); });
    await processInvoice(bad, a.worker.id);

    const [month] = await usageReport(a.firm.id, new Date(), 1);
    expect(month).toMatchObject({ ocrAnalyses: 2, ocrFailures: 1, xmlParsed: 0 });
  });
});
