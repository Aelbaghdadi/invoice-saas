// El taco entero en un PDF (entrega B, I4): se sube de verdad por /api/uploads
// (wholeTaco=1), se divide con la acción real y el S3 falso, y mientras espera
// no cuenta como factura en ningún sitio (B-R9, §2.1, §2.2, 5.8 y 5.9).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PDFDocument } from "pdf-lib";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeTaco, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs, signOut, type TestSessionUser } from "./helpers/session";
import { discardAfterCallbacks, pendingAfterCallbacks, runAfterCallbacks } from "./helpers/after";
import { inFlight } from "./helpers/inflight";
import { stubOcr, stubPages } from "./helpers/ocr";
import { POST as upload } from "@/app/api/uploads/route";
import { GET as tacoPdfRoute } from "@/app/api/archive/tacos/[id]/pdf/route";
import { GET as retryStuck } from "@/app/api/cron/retry-stuck/route";
import { splitWholeTacoAction } from "@/app/dashboard/archivo/tandas/[id]/dividir/actions";
import TacoSplitPage from "@/app/dashboard/archivo/tandas/[id]/dividir/page";
import TacoSplitPicker from "@/components/archive/TacoSplitPickerDynamic";
import { PageHeader } from "@/components/ui/PageHeader";
import { PendingTacoSplits, PendingTacoSplitsNotice } from "@/components/archive/PendingTacoSplits";
import { closePeriodFromBatch } from "@/app/dashboard/worker/batch/actions";
import { closePeriod } from "@/app/dashboard/admin/closures/actions";
import { archiveScope, tacoViewer } from "@/lib/archiveAccess";
import { loadArchiveMetrics } from "@/lib/archiveData";
import { loadBatchRows, loadOpenBatches } from "@/lib/batchGroups";
import { getNextInQueue } from "@/lib/reviewQueue";
import { getObjectBytes } from "@/lib/storage";
import {
  pendingTacoSplitCloseError,
  pendingTacoSplitInPeriod,
  pendingTacoSplits,
  tacoPeriodClosedError,
  TACO_ALREADY_SPLIT_ERROR,
  TACO_PDF_UNREADABLE_ERROR,
  TACO_SPLIT_BUSY_ERROR,
  TACO_SPLIT_FAILED_ERROR,
  TACO_SPLIT_LOST_ERROR,
  TACO_SPLIT_NOT_FOUND_ERROR,
  TACO_SPLIT_VOIDED_ERROR,
} from "@/lib/tacoSplit";
import type { ExtractedInvoice, OcrResult } from "@/lib/ocr";

let a: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
});

/** Un PDF de `pages` páginas distinto en cada llamada (el título lo cambia). */
let pdfSequence = 0;
async function tacoPdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let n = 0; n < pages; n++) doc.addPage();
  doc.setTitle(`taco-${++pdfSequence}`);
  return Buffer.from(await doc.save());
}

/** Sube un taco entero por /api/uploads, por defecto al lote de abril de 2026 de compras del cliente de A. */
async function uploadTaco(
  user: TestSessionUser,
  pages: number,
  options: { clientId?: string; type?: string; month?: number } = {},
): Promise<string> {
  signInAs(user);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(await tacoPdf(pages))], "taco escaneado.pdf", { type: "application/pdf" }));
  form.set("clientId", options.clientId ?? a.client.id);
  form.set("periodType", "MONTHLY");
  form.set("periodMonth", String(options.month ?? 4));
  form.set("periodYear", "2026");
  form.set("type", options.type ?? "PURCHASE");
  form.set("wholeTaco", "1");
  const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
  const body = await res.json();
  if (res.status !== 200 || !body.tacoPdf) throw new Error(`subida del taco: ${res.status} ${JSON.stringify(body)}`);
  return body.batchId as string;
}

const split = (user: TestSessionUser, batchId: string, startPages: number[]) => {
  signInAs(user);
  return splitWholeTacoAction({ batchId, startPages });
};

const batchOf = (id: string) => prisma.uploadBatch.findUniqueOrThrow({ where: { id }, include: { pdfDocument: true } });
/** Objetos del S3 que no son el PDF de un taco: los trozos. */
const pieceKeys = async () => {
  const tacoPdfs = new Set((await prisma.uploadBatch.findMany({ where: { wholePdf: true }, select: { pdfDocument: { select: { storageKey: true } } } }))
    .map((t) => t.pdfDocument?.storageKey));
  return fakeS3().keys().filter((key) => !tacoPdfs.has(key));
};
const tacoInvoices = (batchId: string) =>
  prisma.invoiceArchive.findMany({
    where: { uploadBatchId: batchId },
    include: { invoice: { include: { document: true } } },
    orderBy: { uploadPosition: "asc" },
  });
const pageCountOf = async (key: string) => (await PDFDocument.load(await getObjectBytes(key))).getPageCount();

describe("dividir un taco entero", () => {
  it("7 páginas con inicios 1, 3, 4 y 7: cuatro facturas del cliente y lote del taco, papel desde el alta y su página; después, al OCR", async () => {
    const batchId = await uploadTaco(a.worker, 7, { type: "UNKNOWN" });
    const taco = await batchOf(batchId);
    expect(await split(a.worker, batchId, [1, 3, 4, 7])).toEqual({ ok: true, invoiceCount: 4 });

    const rows = await tacoInvoices(batchId);
    expect(rows.map((r) => r.uploadPosition)).toEqual([1, 3, 4, 7]);
    for (const row of rows) {
      expect(row).toMatchObject({
        splitPart: 0, receivedAt: taco.createdAt, paperBatchId: null, paperHeldByClient: false,
        originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco",
      });
      expect(row.invoice).toMatchObject({
        status: "UPLOADED", clientId: a.client.id, splitFromId: null, type: "PURCHASE", typeUnconfirmed: true,
        periodType: "MONTHLY", periodMonth: 4, periodYear: 2026, fileType: "application/pdf",
      });
      expect(row.invoice.document).toMatchObject({
        clientId: a.client.id, uploadedBy: a.worker.id, storageKey: row.invoice.storageKey, fileHash: row.invoice.fileHash,
      });
    }
    expect(rows.map((r) => r.invoice.filename)).toEqual([
      "Taco 1 - pág. 1-2.pdf", "Taco 1 - pág. 3.pdf", "Taco 1 - pág. 4-6.pdf", "Taco 1 - pág. 7.pdf",
    ]);
    expect(await Promise.all(rows.map((r) => pageCountOf(r.invoice.storageKey)))).toEqual([2, 1, 3, 1]);
    expect((await pieceKeys()).sort()).toEqual(rows.map((r) => r.invoice.storageKey).sort());
    // Las claves van con las del cliente y el lote (las borra el reset de la demo).
    for (const row of rows) expect(row.invoice.storageKey.startsWith(`${a.client.id}/2026-04/`)).toBe(true);

    const after = await batchOf(batchId);
    expect(after.pdfSplitAt).toBeInstanceOf(Date);
    expect(after.pdfSplitById).toBe(a.worker.id);
    // El PDF entero se queda: es el papel del taco.
    expect(after.pdfDocumentId).toBe(taco.pdfDocumentId);
    expect(fakeS3().keys()).toContain(taco.pdfDocument!.storageKey);

    // Un análisis por factura, cada uno en su after(), como /api/uploads.
    expect(pendingAfterCallbacks()).toBe(4);
    let n = 0;
    stubOcr(async (): Promise<OcrResult> => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: a.client.name, receiverCif: a.client.cif,
        invoiceNumber: `T1-${++n}`, invoiceDate: "2026-04-10", taxBase: 100, vatRate: 21, vatAmount: 21,
        irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
      } as ExtractedInvoice,
    }));
    await runAfterCallbacks();
    for (const row of await tacoInvoices(batchId)) {
      expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(row.invoice.status);
      expect(row).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" });
    }
  });

  it("inicios 2 y 5: la página 1 no es de ninguna factura; desordenados y repetidos (4, 1, 4): 1-3 y 4-7", async () => {
    const first = await uploadTaco(a.worker, 7);
    expect(await split(a.worker, first, [2, 5])).toEqual({ ok: true, invoiceCount: 2 });
    const firstRows = await tacoInvoices(first);
    expect(firstRows.map((r) => r.uploadPosition)).toEqual([2, 5]);
    expect(await Promise.all(firstRows.map((r) => pageCountOf(r.invoice.storageKey)))).toEqual([3, 3]);

    const second = await uploadTaco(a.admin, 7);
    expect(await split(a.admin, second, [4, 1, 4])).toEqual({ ok: true, invoiceCount: 2 });
    const secondRows = await tacoInvoices(second);
    expect(secondRows.map((r) => [r.uploadPosition, r.invoice.filename])).toEqual([[1, "Taco 2 - pág. 1-3.pdf"], [4, "Taco 2 - pág. 4-7.pdf"]]);
    expect(await Promise.all(secondRows.map((r) => pageCountOf(r.invoice.storageKey)))).toEqual([3, 4]);
    // Las facturas del admin, con su Document a su nombre.
    expect(secondRows.every((r) => r.invoice.document?.uploadedBy === a.admin.id)).toBe(true);
  });

  it("errores, sin cambios ni objetos nuevos en el S3", async () => {
    const b = await makeFirm("B");
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    const batchId = await uploadTaco(a.worker, 7);
    const invoicesBefore = await prisma.invoice.count();
    const documentsBefore = await prisma.document.count();

    expect(await split(a.worker, batchId, [])).toEqual({ error: "Marca al menos dónde empieza una factura." });
    expect(await split(a.worker, batchId, [1, 8])).toEqual({ error: "La página 8 no existe: el PDF tiene 7 páginas." });
    expect(await split(a.worker, batchId, Array.from({ length: 301 }, (_, i) => i + 1)))
      .toEqual({ error: "Como mucho 300 facturas por taco." });
    expect(await split(a.worker, batchId, [1.5])).toEqual({ error: "Las marcas no valen. Recarga la página." });
    expect(await split(a.worker, "", [1])).toEqual({ error: "Las marcas no valen. Recarga la página." });
    // Otra asesoría, un gestor sin el cliente y el portal.
    expect(await split(b.admin, batchId, [1])).toEqual({ error: "No tienes acceso a este taco." });
    expect(await split(b.worker, batchId, [1])).toEqual({ error: "No tienes acceso a este taco." });
    expect(await split(stranger, batchId, [1])).toEqual({ error: "No tienes acceso a este taco." });
    expect(await split(a.clientUser, batchId, [1])).toEqual({ error: "No autorizado" });
    signOut();
    expect(await splitWholeTacoAction({ batchId, startPages: [1] })).toEqual({ error: "No autorizado" });

    // Un taco de factura a factura no es un taco entero.
    const perInvoice = await makeTaco(a, { period: { periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 } });
    expect(await split(a.worker, perInvoice.id, [1])).toEqual({ error: TACO_SPLIT_NOT_FOUND_ERROR });
    // Anulado.
    const voided = await uploadTaco(a.worker, 3);
    await prisma.uploadBatch.update({
      where: { id: voided },
      data: { voidedAt: new Date(), voidedById: a.worker.id, voidReason: "Subido al cliente equivocado" },
    });
    expect(await split(a.admin, voided, [1])).toEqual({ error: TACO_SPLIT_VOIDED_ERROR });

    expect(await prisma.invoice.count()).toBe(invoicesBefore);
    expect(await prisma.document.count()).toBe(documentsBefore + 1);
    expect(await pieceKeys()).toEqual([]);
    expect((await batchOf(batchId)).pdfSplitAt).toBeNull();

    // El gestor que lo subió y al que después le quitan el cliente ya no lo divide.
    await prisma.workerClientAssignment.deleteMany({ where: { workerId: a.worker.id, clientId: a.client.id } });
    expect(await split(a.worker, batchId, [1])).toEqual({ error: "No tienes acceso a este taco." });

    // Ya dividido: la segunda vez no crea nada.
    expect(await split(a.admin, batchId, [1, 4])).toEqual({ ok: true, invoiceCount: 2 });
    const keys = await pieceKeys();
    expect(await split(a.admin, batchId, [1])).toEqual({ error: TACO_ALREADY_SPLIT_ERROR });
    expect(await prisma.invoice.count()).toBe(invoicesBefore + 2);
    expect((await pieceKeys()).sort()).toEqual(keys.sort());
  });

  it("dos divisiones a la vez: la segunda, «Otra persona está dividiendo…» enseguida; cuatro facturas y en el S3 solo sus trozos", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    fakeS3().setMode("hold");
    const first = inFlight(split(a.worker, batchId, [1, 3, 4, 7]));
    // La primera está descargando el PDF: la segunda no espera a que termine.
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    expect(await split(a.admin, batchId, [1, 2, 3, 4, 5])).toEqual({ error: TACO_SPLIT_BUSY_ERROR });
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    expect(await first).toEqual({ ok: true, invoiceCount: 4 });
    const rows = await tacoInvoices(batchId);
    expect(rows.map((r) => r.uploadPosition)).toEqual([1, 3, 4, 7]);
    expect((await pieceKeys()).sort()).toEqual(rows.map((r) => r.invoice.storageKey).sort());
  });

  it("tres a la vez (Promise.all): solo una crea facturas, y en el S3 solo quedan sus trozos", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    signInAs(a.worker);
    const results = await Promise.all([[1, 3, 4, 7], [1, 2, 3, 4, 5], [1, 7]].map((startPages) =>
      inFlight(splitWholeTacoAction({ batchId, startPages }))));
    const won = results.filter((r): r is { ok: true; invoiceCount: number } => "ok" in r);
    expect(won).toHaveLength(1);
    // La que llega mientras otra divide, «Otra persona…»; la que llega cuando ya ha terminado, «ya está dividido».
    for (const lost of results.filter((r): r is { error: string } => "error" in r)) {
      expect([TACO_SPLIT_BUSY_ERROR, TACO_SPLIT_LOST_ERROR, TACO_ALREADY_SPLIT_ERROR]).toContain(lost.error);
    }
    const rows = await tacoInvoices(batchId);
    expect(rows).toHaveLength(won[0].invoiceCount);
    expect((await pieceKeys()).sort()).toEqual(rows.map((r) => r.invoice.storageKey).sort());
  });

  it("dividido en otro proceso mientras se cortaban los trozos: no reserva, «Otra persona ya ha marcado…» y sus trozos se borran", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    fakeS3().setMode("hold");
    const running = inFlight(split(a.worker, batchId, [1, 3, 4, 7]));
    // Comprobaciones hechas y la descarga del PDF esperando.
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.uploadBatch.update({ where: { id: batchId }, data: { pdfSplitAt: new Date(), pdfSplitById: a.admin.id } });
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    expect(await running).toEqual({ error: TACO_SPLIT_LOST_ERROR });
    expect(await tacoInvoices(batchId)).toEqual([]);
    expect(await pieceKeys()).toEqual([]);
    expect((await batchOf(batchId)).pdfSplitById).toBe(a.admin.id);
  });

  it("anulado mientras se cortaban los trozos: «Este taco está anulado.» y nada", async () => {
    const batchId = await uploadTaco(a.worker, 4);
    fakeS3().setMode("hold");
    const running = inFlight(split(a.worker, batchId, [1, 3]));
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.uploadBatch.update({
      where: { id: batchId },
      data: { voidedAt: new Date(), voidedById: a.admin.id, voidReason: "Era de otro cliente" },
    });
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    expect(await running).toEqual({ error: TACO_SPLIT_VOIDED_ERROR });
    expect(await tacoInvoices(batchId)).toEqual([]);
    expect(await pieceKeys()).toEqual([]);
  });

  describe("si la BD falla a mitad", () => {
    // Fallo de verdad en la BD, en la tercera factura (después de crear las dos primeras).
    beforeEach(async () => {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_taco_falla() RETURNS trigger AS $$
        BEGIN
          IF NEW."filename" LIKE '%pág. 4-6%' THEN RAISE EXCEPTION 'fallo simulado al crear una factura del taco'; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_taco_falla ON "Invoice"`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER test_taco_falla BEFORE INSERT ON "Invoice" FOR EACH ROW EXECUTE FUNCTION test_taco_falla()`);
    });
    afterEach(async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_taco_falla ON "Invoice"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_taco_falla()`);
    });

    it("ninguna factura ni Document, la reserva deshecha y los trozos borrados; después se divide bien", async () => {
      const batchId = await uploadTaco(a.worker, 7);
      const documentsBefore = await prisma.document.count();
      expect(await split(a.worker, batchId, [1, 3, 4, 7])).toEqual({ error: TACO_SPLIT_FAILED_ERROR });
      expect(await tacoInvoices(batchId)).toEqual([]);
      expect(await prisma.document.count()).toBe(documentsBefore);
      expect(await batchOf(batchId)).toMatchObject({ pdfSplitAt: null, pdfSplitById: null });
      expect(await pieceKeys()).toEqual([]);
      expect(pendingAfterCallbacks()).toBe(0);

      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_taco_falla ON "Invoice"`);
      expect(await split(a.worker, batchId, [1, 3, 4, 7])).toEqual({ ok: true, invoiceCount: 4 });
      expect(await tacoInvoices(batchId)).toHaveLength(4);
    });
  });

  it("si el almacenamiento falla al subir los trozos: nada, y se puede volver a intentar", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    // El PDF del taco se descarga bien; los trozos ya no se pueden subir.
    fakeS3().setMode("hold");
    const running = inFlight(split(a.worker, batchId, [1, 3, 4, 7]));
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    fakeS3().setMode("down");
    expect(await running).toEqual({ error: TACO_SPLIT_FAILED_ERROR });
    fakeS3().setMode("ok");
    expect(await tacoInvoices(batchId)).toEqual([]);
    expect((await batchOf(batchId)).pdfSplitAt).toBeNull();
    expect(await pieceKeys()).toEqual([]);
    expect(await split(a.worker, batchId, [1, 3, 4, 7])).toEqual({ ok: true, invoiceCount: 4 });
  });

  it("el PDF del taco no está en el almacenamiento: su error y nada", async () => {
    const batchId = await uploadTaco(a.worker, 3);
    fakeS3().clear();
    expect(await split(a.worker, batchId, [1])).toEqual({ error: TACO_PDF_UNREADABLE_ERROR });
    expect((await batchOf(batchId)).pdfSplitAt).toBeNull();
    expect(fakeS3().keys()).toEqual([]);
  });

  it("la separación automática no vuelve a partir lo que se marcó a mano en el taco entero", async () => {
    const batchId = await uploadTaco(a.worker, 4);
    expect(await split(a.worker, batchId, [1, 3])).toEqual({ ok: true, invoiceCount: 2 });
    // Gemini diría que cada página es otra factura: no se le llega a preguntar.
    let classified = 0;
    stubPages(async () => {
      classified++;
      return [1, 2].map((page) => ({ page, kind: "FACTURA" as const, startsInvoice: true, invoiceNumber: `F-${page}`, issuerCif: "B12345674" }));
    });
    let n = 0;
    stubOcr(async (): Promise<OcrResult> => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: a.client.name, receiverCif: a.client.cif,
        invoiceNumber: `T1-${++n}`, invoiceDate: "2026-04-10", taxBase: 100 * n, vatRate: 21, vatAmount: 21 * n,
        irpfRate: null, irpfAmount: null, totalAmount: 121 * n, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 100 * n, vatRate: 21, vatAmount: 21 * n }], confidence: null,
      } as ExtractedInvoice,
    }));
    await runAfterCallbacks();

    expect(classified).toBe(0);
    const rows = await tacoInvoices(batchId);
    expect(rows.map((r) => [r.uploadPosition, r.splitPart])).toEqual([[1, 0], [3, 0]]);
    for (const row of rows) expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain(row.invoice.status);
    expect(await prisma.invoice.count({ where: { splitFromId: { in: rows.map((r) => r.invoiceId) } } })).toBe(0);
  });
});

describe("el periodo del lote del taco", () => {
  it("cerrado: el texto del periodo cerrado y nada subido", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 4, year: 2026, closedBy: a.admin.id } });
    const closed = tacoPeriodClosedError({ periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 });
    expect(closed).toBe("El periodo Abril 2026 de este cliente está cerrado: pide que lo reabran para dividir el taco.");
    expect(await split(a.worker, batchId, [1, 3])).toEqual({ error: closed });
    expect(await pieceKeys()).toEqual([]);
    expect(fakeS3().getCount()).toBe(0);
    // Reabierto, sí.
    await prisma.periodClosure.updateMany({ where: { clientId: a.client.id }, data: { reopenedAt: new Date(), reopenedBy: a.admin.id } });
    expect(await split(a.worker, batchId, [1, 3])).toEqual({ ok: true, invoiceCount: 2 });
  });

  it("cerrado mientras se cortaban y subían los trozos: el texto del periodo cerrado, ninguna factura, sin reserva y los trozos borrados", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    fakeS3().setMode("hold");
    const running = inFlight(split(a.worker, batchId, [1, 3, 4, 7]));
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 4, year: 2026, closedBy: a.admin.id } });
    fakeS3().setMode("ok");
    fakeS3().releaseGets();
    expect(await running).toEqual({ error: tacoPeriodClosedError({ periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 }) });
    expect(await tacoInvoices(batchId)).toEqual([]);
    expect(await batchOf(batchId)).toMatchObject({ pdfSplitAt: null, pdfSplitById: null });
    expect(await pieceKeys()).toEqual([]);
    expect(pendingAfterCallbacks()).toBe(0);
  });
});

describe("mientras espera, el taco entero no es una factura", () => {
  it("ni en la cola, ni en los lotes, ni en las métricas del archivo, ni en retry-stuck", async () => {
    const scope = (await archiveScope({ user: a.admin }))!;
    const metricsBefore = await loadArchiveMetrics(scope);
    const invoicesBefore = await prisma.invoice.count();
    const batchId = await uploadTaco(a.worker, 7);
    const taco = await batchOf(batchId);

    expect(await prisma.invoice.count()).toBe(invoicesBefore);
    expect(await getNextInQueue("ninguna", { clientId: a.client.id, periodMonth: 4, periodYear: 2026, type: "PURCHASE" })).toBeNull();
    const { openBatches } = await loadOpenBatches(a.firm.id, [a.client.id]);
    expect(openBatches.filter((b) => b.periodYear === 2026 && b.periodMonth === 4)).toEqual([]);
    expect(await loadBatchRows({ clientId: a.client.id, periodMonth: 4, periodYear: 2026 })).toEqual([]);
    expect(await loadArchiveMetrics(scope)).toEqual(metricsBefore);

    // Subido hace 10 minutos: retry-stuck relanza lo que lleva más de 5 en UPLOADED.
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await prisma.$executeRaw`UPDATE "Document" SET "createdAt" = ${tenMinutesAgo} WHERE "id" = ${taco.pdfDocumentId}`;
    const res = await retryStuck(new Request("http://x/api/cron", { headers: { authorization: "Bearer cron-test" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ retried: 0, uploaded: 0 });
    expect(await prisma.invoice.count()).toBe(invoicesBefore);
  });
});

describe("cerrar el periodo con un taco entero sin dividir (5.9)", () => {
  const batchForm = (month = 4) => {
    const form = new FormData();
    form.set("clientId", a.client.id);
    form.set("month", String(month));
    form.set("year", "2026");
    form.set("type", "PURCHASE");
    return form;
  };
  const closureForm = (month = 4) => {
    const form = new FormData();
    form.set("clientId", a.client.id);
    form.set("month", String(month));
    form.set("year", "2026");
    return form;
  };

  it("ni desde Lotes ni desde Cierres; tras dividirlo, queda el motivo de las facturas pendientes", async () => {
    const batchId = await uploadTaco(a.worker, 7);
    expect(await pendingTacoSplitInPeriod(a.client.id, 4, 2026)).toBe(1);
    const error = pendingTacoSplitCloseError(1);
    expect(error).toBe("No se puede cerrar: el Taco 1 de este periodo está sin dividir. Marca dónde empieza cada factura primero (o anúlalo si se subió por error).");

    signInAs(a.worker);
    expect(await closePeriodFromBatch(null, batchForm())).toEqual({ error });
    signInAs(a.admin);
    expect(await closePeriodFromBatch(null, batchForm())).toEqual({ error });
    expect(await closePeriod(closureForm())).toEqual({ error });
    expect(await prisma.periodClosure.count()).toBe(0);
    expect(pendingAfterCallbacks()).toBe(0);

    expect(await split(a.worker, batchId, [1, 3, 4, 7])).toEqual({ ok: true, invoiceCount: 4 });
    discardAfterCallbacks();
    expect(await pendingTacoSplitInPeriod(a.client.id, 4, 2026)).toBeNull();
    signInAs(a.worker);
    expect(await closePeriodFromBatch(null, batchForm())).toEqual({ error: "Aún quedan 4 facturas sin procesar en el periodo" });
    expect(await prisma.periodClosure.count()).toBe(0);
  });

  it("anulado o de otro periodo, no lo impide", async () => {
    const voided = await uploadTaco(a.worker, 3);
    await prisma.uploadBatch.update({
      where: { id: voided },
      data: { voidedAt: new Date(), voidedById: a.worker.id, voidReason: "Subido al cliente equivocado" },
    });
    await uploadTaco(a.worker, 3, { month: 5 });
    expect(await pendingTacoSplitInPeriod(a.client.id, 4, 2026)).toBeNull();
    expect(await pendingTacoSplitInPeriod(a.client.id, 5, 2026)).toBe(2);

    signInAs(a.admin);
    expect(await closePeriod(closureForm(4))).toEqual({ success: true });
    signInAs(a.worker);
    expect(await closePeriodFromBatch(null, batchForm(5))).toEqual({ error: pendingTacoSplitCloseError(2) });
    expect(await prisma.periodClosure.findMany({ select: { month: true } })).toEqual([{ month: 4 }]);
  });
});

describe("pendingTacoSplits (avisos de los paneles)", () => {
  it("el admin y el gestor con el cliente lo ven; otro gestor y otra asesoría, no; anulado o dividido, nadie", async () => {
    const b = await makeFirm("B");
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    const batchId = await uploadTaco(a.worker, 7);
    const seen = async (user: TestSessionUser) => {
      const viewer = await tacoViewer({ user });
      return viewer ? (await pendingTacoSplits(viewer)).map((t) => [t.tacoNumber, t.clientName, t.pageCount]) : null;
    };
    expect(await seen(a.admin)).toEqual([[1, a.client.name, 7]]);
    expect(await seen(a.worker)).toEqual([[1, a.client.name, 7]]);
    expect(await seen(stranger)).toEqual([]);
    expect(await seen(b.admin)).toEqual([]);
    expect(await seen(b.worker)).toEqual([]);
    expect(await seen(a.clientUser)).toBeNull();

    const voided = await uploadTaco(a.worker, 2);
    await prisma.uploadBatch.update({
      where: { id: voided },
      data: { voidedAt: new Date(), voidedById: a.worker.id, voidReason: "Subido dos veces" },
    });
    expect(await seen(a.admin)).toEqual([[1, a.client.name, 7]]);
    expect(await split(a.worker, batchId, [1])).toEqual({ ok: true, invoiceCount: 1 });
    expect(await seen(a.admin)).toEqual([]);
  });

  it("el aviso: «Tienes 1 taco entero por dividir…» con «Marcar las facturas»; con más de 3, «y N más»; sin ninguno, nada", async () => {
    const viewer = (await tacoViewer({ user: a.worker }))!;
    expect(renderToStaticMarkup(await PendingTacoSplits({ viewer }))).toBe("");

    const first = await uploadTaco(a.worker, 7);
    const one = renderToStaticMarkup(await PendingTacoSplits({ viewer }));
    expect(one).toContain(`Tienes 1 taco entero por dividir: T1 (${a.client.name}, 7 páginas).`);
    expect(one).toContain(`href="/dashboard/archivo/tandas/${first}/dividir"`);
    expect(one).toContain("Marcar las facturas");

    for (const pages of [1, 2, 3, 4]) await uploadTaco(a.worker, pages);
    const five = renderToStaticMarkup(createElement(PendingTacoSplitsNotice, {
      splits: await pendingTacoSplits(viewer),
      wording: "archive",
    }));
    expect(five).toContain(`Hay 5 tacos enteros por dividir: T1 (${a.client.name}, 7 páginas), T2 (${a.client.name}, 1 página), T3 (${a.client.name}, 2 páginas) y `);
    expect(five).toContain('href="/dashboard/archivo/tacos?estado=por-dividir"');
    expect(five).toContain("2 más");
    expect(five).toContain("T3: marcar las facturas");
    expect(five).not.toContain("T4: marcar las facturas");
  });
});

/** Las props de los elementos de ese componente en el árbol que devuelve una página (sin pintarla). */
function propsOf<P>(node: ReactNode, type: unknown, out: P[] = []): P[] {
  if (Array.isArray(node)) node.forEach((child) => propsOf(child, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node.props as P);
    propsOf((node.props as { children?: ReactNode }).children, type, out);
  }
  return out;
}

describe("la pantalla de las marcas (/dashboard/archivo/tandas/[id]/dividir)", () => {
  const open = (user: TestSessionUser, id: string) => {
    signInAs(user);
    return TacoSplitPage({ params: Promise.resolve({ id }) }).then(
      (page) => ({ page, redirect: null as string | null, notFound: false }),
      (e: { message?: string; url?: string }) => {
        if (e?.message === "NEXT_REDIRECT") return { page: null, redirect: e.url ?? "", notFound: false };
        if (e?.message === "NEXT_NOT_FOUND") return { page: null, redirect: null, notFound: true };
        throw e;
      },
    );
  };

  it("con su taco, su lote y la URL del PDF; 404 sin acceso; el portal fuera; dividido o anulado, al detalle", async () => {
    const b = await makeFirm("B");
    const batchId = await uploadTaco(a.worker, 7, { type: "SALE" });
    const shown = await open(a.worker, batchId);
    const header = propsOf<{ title: string; description: string }>(shown.page, PageHeader)[0];
    expect(header.title).toBe("Taco 1: marca dónde empieza cada factura");
    expect(header.description).toBe(
      `${a.client.name} · Abril 2026 · Emitidas · 7 páginas. Pulsa en la primera página de cada factura. Las páginas que siguen van con ella hasta la siguiente marca. Como mucho 300 facturas por taco.`,
    );
    expect(propsOf(shown.page, TacoSplitPicker)[0]).toEqual({
      batchId, tacoNumber: 1, clientName: a.client.name, lotLabel: "Abril 2026 · Emitidas", pageCount: 7,
      pdfUrl: `/api/archive/tacos/${batchId}/pdf`,
    });

    expect((await open(b.admin, batchId)).notFound).toBe(true);
    expect((await open(await makeUser(a.firm.id, "WORKER", "gestorsincliente"), batchId)).notFound).toBe(true);
    expect((await open(a.clientUser, batchId)).redirect).toBe("/dashboard");
    const perInvoice = await makeTaco(a);
    expect((await open(a.admin, perInvoice.id)).notFound).toBe(true);

    expect(await split(a.worker, batchId, [1, 4])).toEqual({ ok: true, invoiceCount: 2 });
    expect((await open(a.worker, batchId)).redirect).toBe(`/dashboard/archivo/tandas/${batchId}`);
    const voided = await uploadTaco(a.worker, 2);
    await prisma.uploadBatch.update({
      where: { id: voided },
      data: { voidedAt: new Date(), voidedById: a.worker.id, voidReason: "Subido dos veces" },
    });
    expect((await open(a.admin, voided)).redirect).toBe(`/dashboard/archivo/tandas/${voided}`);
  });
});

describe("GET /api/archive/tacos/[id]/pdf", () => {
  const get = (user: TestSessionUser | null, id: string) => {
    if (user) signInAs(user);
    else signOut();
    return tacoPdfRoute(new NextRequest("http://app.local/api/archive/tacos/x/pdf"), { params: Promise.resolve({ id }) });
  };

  it("el PDF entero, en línea y sin caché, para el admin y el gestor con el cliente; 404 para los demás; 401 sin sesión", async () => {
    const b = await makeFirm("B");
    const batchId = await uploadTaco(a.worker, 3);
    const stored = await getObjectBytes((await batchOf(batchId)).pdfDocument!.storageKey);
    for (const user of [a.admin, a.worker]) {
      const res = await get(user, batchId);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toBe("inline");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await res.arrayBuffer()).equals(stored)).toBe(true);
    }
    // Dividido, sigue ahí.
    expect(await split(a.admin, batchId, [1])).toEqual({ ok: true, invoiceCount: 1 });
    expect((await get(a.worker, batchId)).status).toBe(200);

    for (const user of [b.admin, b.worker, await makeUser(a.firm.id, "WORKER", "gestorsincliente"), a.clientUser]) {
      expect((await get(user, batchId)).status).toBe(404);
    }
    // Un taco de factura a factura no tiene PDF.
    const perInvoice = await makeTaco(a);
    expect((await get(a.admin, perInvoice.id)).status).toBe(404);
    expect((await get(a.admin, "no-existe")).status).toBe(404);
    expect((await get(null, batchId)).status).toBe(401);

    // El gestor que lo subió y al que le quitan el cliente, ya no.
    await prisma.workerClientAssignment.deleteMany({ where: { workerId: a.worker.id, clientId: a.client.id } });
    expect((await get(a.worker, batchId)).status).toBe(404);
  });

  it("si el PDF no está en el almacenamiento: 404 con su texto", async () => {
    const batchId = await uploadTaco(a.worker, 2);
    fakeS3().clear();
    const res = await get(a.admin, batchId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "El PDF del taco no está en el almacenamiento." });
  });
});
