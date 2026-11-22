// La separación automática (autoSplit.ts) con el papel de la entrega B: una
// subida «entre varias» que se separa deja hijas de varios clientes en la
// misma familia, y la división se puede cruzar con una escritura del taco.
import { describe, it, expect, beforeEach } from "vitest";
import type { Client, Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, makeTaco, type FirmWorld } from "./helpers/factories";
import { blankPdf } from "./helpers/fixtures";
import { stubOcr, stubPages } from "./helpers/ocr";
import { signInAs } from "./helpers/session";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { processInvoice } from "@/lib/processInvoice";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { isValidNIF } from "@/lib/validators";
import { placePaperAction, previewPlacePaperAction } from "@/app/dashboard/archivo/tacoActions";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { PageReading } from "@/lib/pdfSegmentation";

let w: FirmWorld;
const validCif = (digits: string) => [..."0123456789ABCDEFGHIJ"].map((c) => `B${digits}${c}`).find(isValidNIF)!;
const factura = (page: number, invoiceNumber: string): PageReading =>
  ({ page, kind: "FACTURA", startsInvoice: true, invoiceNumber, issuerCif: "B12345674" });

/** OCR de cada hija, en orden: una compra distinta para cada receptor. */
function stubInvoices(receiverCifs: string[]) {
  let n = 0;
  stubOcr(async () => {
    n++;
    return {
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: null, receiverCif: receiverCifs.shift()!,
        invoiceNumber: `T-${n}`, invoiceDate: "2026-09-10", taxBase: 1000 * n, vatRate: 21, vatAmount: 210 * n,
        irpfRate: null, irpfAmount: null, totalAmount: 1210 * n, currency: "EUR",
        vatLines: [{ taxBase: 1000 * n, vatRate: 21, vatAmount: 210 * n }], confidence: null,
      } as ExtractedInvoice,
    };
  });
}

beforeEach(async () => {
  w = await makeFirm("A");
});

/** A (del gestor) y B (de la asesoría, pero el gestor no la tiene). */
async function twoClients() {
  const a = await prisma.client.update({ where: { id: w.client.id }, data: { cif: validCif("1111111") } });
  const b = await prisma.client.create({ data: { name: "Empresa B SL", cif: validCif("2222222"), advisoryFirmId: w.firm.id } });
  return { a, b };
}

/** Un PDF de dos facturas subido «entre varias» (al buzón), ya separado: una hija para A y otra para B. */
async function splitBetween(a: Client, b: Client, archive: Prisma.InvoiceArchiveUncheckedUpdateInput = {}) {
  const bucket = await getOrCreateUnclassifiedClient(w.firm.id);
  stubPages(async () => [factura(1, "F-1"), factura(2, "F-2")]);
  stubInvoices([a.cif, b.cif]);
  const key = `k-${Math.random()}`;
  fakeS3().put(key, await blankPdf(2));
  const root = await makeInvoice(bucket, {
    filename: "taco.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED",
    invoiceNumber: null, issuerCif: null, totalAmount: null, routingCandidateIds: [a.id, b.id],
  });
  if (Object.keys(archive).length > 0) await prisma.invoiceArchive.update({ where: { invoiceId: root.id }, data: archive });

  await processInvoice(root.id, w.worker.id);

  const children = await prisma.invoice.findMany({ where: { splitFromId: root.id } });
  const childA = children.find((c) => c.clientId === a.id);
  const childB = children.find((c) => c.clientId === b.id);
  if (!childA || !childB) throw new Error(`la separación no repartió las hijas: ${JSON.stringify(children.map((c) => c.clientId))}`);
  return { childA, childB };
}

const archiveOf = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });

describe("una familia repartida entre dos clientes", () => {
  it("«Sacar del taco» la de A no se lleva la de B a la caja de A", async () => {
    const { a, b } = await twoClients();
    const taco = await makeTaco(w, { clientId: null, candidateIds: [a.id, b.id], fileCount: 1 });
    const { childA, childB } = await splitBetween(a, b, {
      uploadBatchId: taco.id, uploadPosition: 1, receivedAt: taco.createdAt,
      originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco",
    });
    const beforeB = await archiveOf(childB.id);

    signInAs(w.worker);
    expect(await previewPlacePaperAction({ target: { moveInvoiceId: childA.id } })).toMatchObject({ ok: true, placeable: 1 });
    const moved = await placePaperAction({ target: { moveInvoiceId: childA.id }, destination: { kind: "box", label: "Caja 9" } });
    expect("ok" in moved).toBe(true);

    const archiveTaco = await prisma.uploadBatch.findFirstOrThrow({ where: { origin: "ARCHIVE" } });
    expect(archiveTaco.clientId).toBe(a.id);
    expect((await archiveOf(childA.id)).paperBatchId).toBe(archiveTaco.id);
    expect(await archiveOf(childB.id)).toEqual(beforeB);
  });

  it("«Poner ubicación» a todo lo de A no cuenta ni ubica la hija de B", async () => {
    const { a, b } = await twoClients();
    const { childA, childB } = await splitBetween(a, b);
    const beforeB = await archiveOf(childB.id);

    signInAs(w.worker);
    const target = { clientId: a.id, fiscalYear: 2026, includeUnconfirmed: true };
    const preview = await previewPlacePaperAction({ target });
    if (!("ok" in preview)) throw new Error(preview.error);
    const placed = await placePaperAction({ target, destination: { kind: "box", label: "Caja 1" } });
    expect("ok" in placed).toBe(true);

    const archiveTaco = await prisma.uploadBatch.findFirstOrThrow({ where: { origin: "ARCHIVE" } });
    expect((await archiveOf(childA.id)).paperBatchId).toBe(archiveTaco.id);
    expect(await archiveOf(childB.id)).toEqual(beforeB);
    // Lo contado es lo ubicado, y todo es de A (las de makeFirm y la hija de A).
    const inBox = await prisma.invoiceArchive.findMany({ where: { paperBatchId: archiveTaco.id }, include: { invoice: true } });
    expect(inBox).toHaveLength(preview.placeable);
    expect(new Set(inBox.map((row) => row.invoice.clientId))).toEqual(new Set([a.id]));
  });
});

describe("la separación automática y una escritura del taco a la vez", () => {
  it("si Postgres la aborta por el cruce (40P01), la separación se repite y no se pierde", async () => {
    const taco = await makeTaco(w, { fileCount: 1 });
    stubPages(async () => [factura(1, "F-1"), factura(2, "F-2")]);
    stubInvoices([w.client.cif, w.client.cif]);
    const key = `k-${Math.random()}`;
    fakeS3().put(key, await blankPdf(2));
    const root = await makeInvoice(w.client, {
      filename: "taco.pdf", storageKey: key, fileType: "application/pdf", status: "UPLOADED",
      invoiceNumber: null, issuerCif: null, totalAmount: null,
    });
    await prisma.invoiceArchive.update({
      where: { invoiceId: root.id },
      data: {
        uploadBatchId: taco.id, uploadPosition: 1, receivedAt: taco.createdAt,
        originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco",
      },
    });

    // Como «Guardar en caja», «Era papel» o «Anular»: la tanda FOR UPDATE y después sus filas.
    const held = await holdLock(`SELECT 1 FROM "UploadBatch" WHERE "id" = $1 FOR UPDATE`, taco.id);
    const analysis = processInvoice(root.id, w.worker.id);
    const end = Date.now() + 8000;
    while (Date.now() < end && (await sessionsWaitingForLock()) < 1) await new Promise((r) => setTimeout(r, 25));
    expect(await sessionsWaitingForLock()).toBeGreaterThanOrEqual(1);
    // Una de las dos cae con 40P01; si es esta, el gestor ve el aviso de conflicto y repite.
    await held
      .release(`SELECT 1 FROM "InvoiceArchive" WHERE "uploadBatchId" = $1 ORDER BY "invoiceId" FOR UPDATE`)
      .catch(() => {});
    await analysis;

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: root.id } })).status).toBe("SPLIT_SOURCE");
    const children = await prisma.invoice.findMany({ where: { splitFromId: root.id }, include: { archive: true } });
    expect(children.map((c) => [c.archive?.uploadBatchId, c.archive?.uploadPosition])).toEqual([[taco.id, 1], [taco.id, 1]]);
  });
});
