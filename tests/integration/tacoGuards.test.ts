// Guardas de los tacos (migración 13). Lo que fija una tanda no cambia; su nº
// de ficheros solo crece en un taco de factura a factura sin anular; un taco
// entero nace con su PDF y se divide una vez; se anula una vez y con motivo,
// y anulado ya no cambia de caja; solo un taco con nº se guarda o se devuelve;
// el papel ubicado a mano lleva nº; el cliente, los candidatos y el PDF son
// de la asesoría de la tanda, y la tanda o el taco de una fila de archivo
// también; el taco del papel tiene nº. Cada guarda lleva su mutante: sin su
// trigger (DROP TRIGGER en una transacción que se deshace), lo prohibido sale
// bien.
import { describe, it, expect, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeTaco, type FirmWorld } from "./helpers/factories";

class Rollback extends Error {}

/** Margen para una BD de pruebas lenta: lo que se prueba no es el tiempo. */
const TX = { maxWait: 10_000, timeout: 30_000 };

/** Mutante: `act` con el trigger quitado, en una transacción que se deshace. */
async function withoutTrigger<T>(
  table: string,
  trigger: string,
  act: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "${table}"`);
    result = await act(tx);
    throw new Rollback();
  }, TX).catch((err) => {
    if (!(err instanceof Rollback)) throw err;
  });
  return result as T;
}

/** Los SQLSTATE y los mensajes que trae un error de Prisma (con adapter-pg van anidados). */
function errorDetails(err: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return;
    seen.add(value);
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (typeof inner === "string" && /^(code|originalCode)$/.test(key)) codes.push(inner);
      else if (typeof inner === "string" && /message/i.test(key)) texts.push(inner);
      else visit(inner, depth + 1);
    }
    if (value instanceof Error) {
      texts.push(value.message);
      visit((value as { cause?: unknown }).cause, depth + 1);
    }
  };
  visit(err, 0);
  return { codes, text: texts.join("\n") };
}

/** Falla por una guarda: check_violation con su mensaje en castellano. */
async function expectGuard(action: Promise<unknown>, message: RegExp) {
  const err = await action.then(() => null, (e: unknown) => e);
  expect(err, "la operación tenía que fallar").not.toBeNull();
  const { codes, text } = errorDetails(err);
  expect(codes).toContain("23514");
  expect(text).toMatch(message);
}

const FIJA = /Archivo: una tanda no cambia de asesoría, cliente, origen, lote, tipo ni PDF/;
const FICHEROS = /Archivo: el nº de ficheros de una tanda no baja, y solo crece en un taco de factura a factura sin anular/;
const ENTERO = /Archivo: un taco entero es un taco subido, de un solo cliente, de un solo fichero y con su PDF/;
const SOLO_ENTERO = /Archivo: solo un taco entero lleva PDF y división/;
const QUIEN_DIVIDE = /Archivo: la división de un taco entero va con quién la hizo/;
const UNA_VEZ = /Archivo: un taco entero se divide una sola vez/;
const ARCHIVE_SIN_NUMERO = /Archivo: el papel ubicado a mano va en un taco con nº/;
const ANULAR = /Archivo: solo se anula un taco subido, una vez y con su motivo/;
const ANULADO = /Archivo: un taco anulado no cambia de motivo ni se divide/;
const ASESORIA = /Archivo: el cliente, los candidatos o el PDF de la tanda no son de su asesoría/;
const OTRA_ASESORIA = /Archivo: la tanda o el taco son de otra asesoría/;
const SIN_NUMERO_CAJA = /Archivo: solo un taco con nº se guarda en una caja o se devuelve/;
const ANULADO_CAJA = /Archivo: un taco anulado no cambia de caja ni se devuelve/;
const PAPEL_SIN_NUMERO = /Archivo: el papel solo se pone en un taco con nº/;

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

const update = (id: string, data: Prisma.UploadBatchUncheckedUpdateInput) => prisma.uploadBatch.update({ where: { id }, data });

/** Datos mínimos de una tanda de A para insertarla a mano. */
const batchData = (data: Partial<Prisma.UploadBatchUncheckedCreateInput> = {}): Prisma.UploadBatchUncheckedCreateInput => ({
  advisoryFirmId: a.firm.id,
  clientId: a.client.id,
  createdById: a.worker.id,
  fileCount: 3,
  periodType: "MONTHLY",
  periodMonth: 9,
  periodYear: 2026,
  invoiceType: "PURCHASE",
  ...data,
});

async function pdfDocument(w: FirmWorld, clientId = w.client.id) {
  return prisma.document.create({
    data: { filename: "taco.pdf", storageKey: `${clientId}/2026-09/taco-${Math.random()}.pdf`, fileType: "application/pdf", clientId },
  });
}

describe("lo que fija una tanda no cambia", () => {
  it("asesoría, cliente, candidatos, origen, creador, creación, lote, tipo y PDF", async () => {
    const taco = await makeTaco(a);
    const whole = await makeTaco(a, { wholePdf: { pageCount: 7 } });
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B88888881", advisoryFirmId: a.firm.id } });
    const otherDocument = await pdfDocument(a);

    await expectGuard(update(taco.id, { advisoryFirmId: b.firm.id }), FIJA);
    await expectGuard(update(taco.id, { clientId: otherClient.id }), FIJA);
    await expectGuard(update(taco.id, { clientId: null }), FIJA);
    await expectGuard(update(taco.id, { routingCandidateIds: [otherClient.id] }), FIJA);
    await expectGuard(update(taco.id, { origin: "ARCHIVE" }), FIJA);
    await expectGuard(update(taco.id, { createdById: a.admin.id }), FIJA);
    await expectGuard(update(taco.id, { createdAt: new Date("2026-01-01T00:00:00Z") }), FIJA);
    await expectGuard(update(taco.id, { periodType: "QUARTERLY" }), FIJA);
    await expectGuard(update(taco.id, { periodMonth: 10 }), FIJA);
    await expectGuard(update(taco.id, { periodYear: 2025 }), FIJA);
    await expectGuard(update(taco.id, { invoiceType: "SALE" }), FIJA);
    await expectGuard(update(whole.id, { pdfDocumentId: otherDocument.id }), FIJA);
    await expectGuard(update(whole.id, { pdfPageCount: 8 }), FIJA);
    // Cambiar el modo choca antes con la forma de un taco entero o de uno que no lo es.
    await expectGuard(update(taco.id, { wholePdf: true }), ENTERO);
    await expectGuard(update(whole.id, { wholePdf: false }), SOLO_ENTERO);

    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: taco.id } })).toMatchObject({
      advisoryFirmId: a.firm.id, clientId: a.client.id, origin: "UPLOAD", periodMonth: 9, invoiceType: "PURCHASE", wholePdf: false,
    });
  });

  it("guardar en caja, devolver, «Era papel» (poner el nº) y escribir lo mismo sí se puede", async () => {
    const taco = await makeTaco(a);
    const digital = await makeTaco(a, { tacoNumber: null });
    const archive = await makeTaco(a, { origin: "ARCHIVE" });
    const whole = await makeTaco(a, { wholePdf: { pageCount: 4 } });
    await update(taco.id, { boxLabel: "Cliente A SL · 2026 · Caja 1", filedAt: new Date(), filedById: a.worker.id });
    await update(taco.id, { boxLabel: null, returnedAt: new Date(), filedAt: new Date(), filedById: a.admin.id });
    await update(archive.id, { boxLabel: "Caja 3", filedAt: new Date(), filedById: a.worker.id });
    await update(whole.id, { boxLabel: "Caja 4", filedAt: new Date(), filedById: a.worker.id });
    await update(digital.id, { tacoNumber: 90 });
    await update(taco.id, { clientId: a.client.id, periodMonth: 9, fileCount: taco.fileCount });
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: digital.id } })).toMatchObject({ tacoNumber: 90 });
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: taco.id } })).toMatchObject({ boxLabel: null, filedById: a.admin.id });
  });

  it("mutante: sin el trigger, la tanda cambia de cliente y de lote", async () => {
    const taco = await makeTaco(a);
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B88888882", advisoryFirmId: a.firm.id } });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: taco.id }, data: { clientId: otherClient.id, periodMonth: 10 } })))
      .toMatchObject({ clientId: otherClient.id, periodMonth: 10 });
  });
});

describe("el nº de ficheros", () => {
  it("no baja; sube solo en un taco de factura a factura sin anular", async () => {
    const taco = await makeTaco(a, { fileCount: 3 });
    await expectGuard(update(taco.id, { fileCount: 2 }), FICHEROS);
    await update(taco.id, { fileCount: 5 });
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: taco.id } })).fileCount).toBe(5);

    const digital = await makeTaco(a, { tacoNumber: null });
    const whole = await makeTaco(a, { wholePdf: { pageCount: 4 } });
    const archive = await makeTaco(a, { origin: "ARCHIVE" });
    const voided = await makeTaco(a, { voided: { reason: "Subido al cliente equivocado" } });
    for (const batch of [digital, archive, voided]) {
      await expectGuard(update(batch.id, { fileCount: batch.fileCount + 1 }), FICHEROS);
    }
    // El taco entero es siempre un fichero: lo para antes su forma.
    await expectGuard(update(whole.id, { fileCount: 2 }), ENTERO);
  });

  it("mutante: sin el trigger, baja y crece en una tanda digital", async () => {
    const taco = await makeTaco(a, { fileCount: 3 });
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 3 });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: taco.id }, data: { fileCount: 1 } }))).toMatchObject({ fileCount: 1 });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: digital.id }, data: { fileCount: 4 } }))).toMatchObject({ fileCount: 4 });
  });
});

describe("el taco entero", () => {
  it("nace con nº, cliente, un fichero y su PDF; una tanda que no es entera no lleva PDF", async () => {
    const doc = await pdfDocument(a);
    const whole = { wholePdf: true, tacoNumber: 1, fileCount: 1, pdfDocumentId: doc.id, pdfPageCount: 5 };
    const create = (data: Partial<Prisma.UploadBatchUncheckedCreateInput>) => prisma.uploadBatch.create({ data: batchData(data) });
    await expectGuard(create({ ...whole, tacoNumber: null }), ENTERO);
    await expectGuard(create({ ...whole, pdfDocumentId: null }), ENTERO);
    await expectGuard(create({ ...whole, pdfPageCount: null }), ENTERO);
    await expectGuard(create({ ...whole, pdfPageCount: 0 }), ENTERO);
    await expectGuard(create({ ...whole, fileCount: 2 }), ENTERO);
    await expectGuard(create({ ...whole, clientId: null }), ENTERO);
    await expectGuard(create({ ...whole, origin: "ARCHIVE" }), ENTERO);
    await expectGuard(create({ tacoNumber: 1, pdfDocumentId: doc.id, pdfPageCount: 5 }), SOLO_ENTERO);
    await expectGuard(create({ tacoNumber: 1, pdfSplitAt: new Date(), pdfSplitById: a.worker.id }), SOLO_ENTERO);
    await expectGuard(create({ ...whole, pdfSplitAt: new Date() }), QUIEN_DIVIDE);
    expect(await prisma.uploadBatch.count()).toBe(0);

    const ok = await create(whole);
    expect(ok).toMatchObject({ wholePdf: true, pdfDocumentId: doc.id, pdfPageCount: 5, pdfSplitAt: null });
  });

  it("se divide una vez, con quién lo hizo", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 7 } });
    await expectGuard(update(whole.id, { pdfSplitAt: new Date() }), QUIEN_DIVIDE);
    const splitAt = new Date("2026-11-21T10:00:00Z");
    await update(whole.id, { pdfSplitAt: splitAt, pdfSplitById: a.worker.id });
    await expectGuard(update(whole.id, { pdfSplitAt: new Date() }), UNA_VEZ);
    await expectGuard(update(whole.id, { pdfSplitById: a.admin.id }), UNA_VEZ);
    await expectGuard(update(whole.id, { pdfSplitAt: null, pdfSplitById: null }), UNA_VEZ);
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: whole.id } })).toMatchObject({ pdfSplitAt: splitAt, pdfSplitById: a.worker.id });
  });

  it("mutante: sin el trigger, un taco entero sin nº ni PDF entra y se divide dos veces", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 7, split: { byId: a.worker.id } } });
    const created = await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.create({ data: batchData({ wholePdf: true, fileCount: 2 }) }));
    expect(created).toMatchObject({ wholePdf: true, tacoNumber: null, pdfDocumentId: null });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: whole.id }, data: { pdfSplitById: a.admin.id } }))).toMatchObject({ pdfSplitById: a.admin.id });
  });
});

describe("anular un taco", () => {
  const voidData = (reason: string | null = "Subido al cliente equivocado") =>
    ({ voidedAt: new Date(), voidedById: a.worker.id, voidReason: reason });

  it("un taco subido, una vez y con un motivo de 2 a 200 caracteres", async () => {
    const taco = await makeTaco(a);
    await expectGuard(update(taco.id, { voidedAt: new Date(), voidedById: a.worker.id }), ANULAR);
    await expectGuard(update(taco.id, voidData("x")), ANULAR);
    await expectGuard(update(taco.id, voidData("x".repeat(201))), ANULAR);
    await update(taco.id, voidData("x".repeat(200)));
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: taco.id } })).voidReason).toHaveLength(200);

    const digital = await makeTaco(a, { tacoNumber: null });
    const archive = await makeTaco(a, { origin: "ARCHIVE" });
    await expectGuard(update(digital.id, voidData()), ANULAR);
    await expectGuard(update(archive.id, voidData()), ANULAR);
  });

  it("anulado, no cambia de motivo, no vuelve atrás y no se divide", async () => {
    const taco = await makeTaco(a, { voided: { reason: "Vacío" } });
    const whole = await makeTaco(a, { wholePdf: { pageCount: 7 }, voided: { reason: "PDF equivocado" } });
    await expectGuard(update(taco.id, { voidReason: "Otro motivo" }), ANULADO);
    await expectGuard(update(taco.id, { voidedAt: null, voidedById: null, voidReason: null }), ANULADO);
    await expectGuard(update(taco.id, { voidedById: a.admin.id }), ANULADO);
    await expectGuard(update(whole.id, { pdfSplitAt: new Date(), pdfSplitById: a.worker.id }), ANULADO);
  });

  it("anulado, no se guarda en una caja, no cambia de caja ni se devuelve; anular uno ya guardado sí se puede", async () => {
    const voided = await makeTaco(a, { voided: { reason: "Vacío" } });
    await expectGuard(update(voided.id, { boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id }), ANULADO_CAJA);
    await expectGuard(update(voided.id, { returnedAt: new Date(), filedAt: new Date(), filedById: a.worker.id }), ANULADO_CAJA);

    const filedAt = new Date("2026-11-20T10:00:00Z");
    const filed = await makeTaco(a, { filed: { boxLabel: "Cliente A SL · 2026 · Caja 1", at: filedAt } });
    await update(filed.id, voidData());
    await expectGuard(update(filed.id, { boxLabel: "Cliente A SL · 2026 · Caja 2" }), ANULADO_CAJA);
    await expectGuard(update(filed.id, { boxLabel: null, returnedAt: new Date() }), ANULADO_CAJA);
    await expectGuard(update(filed.id, { filedAt: new Date() }), ANULADO_CAJA);
    await expectGuard(update(filed.id, { filedById: a.admin.id }), ANULADO_CAJA);
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: filed.id } }))
      .toMatchObject({ boxLabel: "Cliente A SL · 2026 · Caja 1", returnedAt: null, filedAt, voidReason: "Subido al cliente equivocado" });
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: voided.id } })).boxLabel).toBeNull();
  });

  it("mutante: sin el trigger, se anula una tanda digital sin motivo, se cambia el motivo y un anulado cambia de caja", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    const voided = await makeTaco(a, { voided: { reason: "Vacío" } });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: digital.id }, data: { voidedAt: new Date() } }))).toMatchObject({ voidReason: null });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: voided.id }, data: { voidReason: "Otro" } }))).toMatchObject({ voidReason: "Otro" });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: voided.id }, data: { boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id } })))
      .toMatchObject({ boxLabel: "Caja 1" });
  });
});

describe("solo un taco (con nº) se guarda en una caja o se devuelve", () => {
  it("una tanda digital no lleva caja, devolución ni «guardado»; al convertirla en taco, sí", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    await expectGuard(update(digital.id, { boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id }), SIN_NUMERO_CAJA);
    await expectGuard(update(digital.id, { returnedAt: new Date(), filedAt: new Date(), filedById: a.worker.id }), SIN_NUMERO_CAJA);
    await expectGuard(update(digital.id, { boxLabel: "Caja 1" }), SIN_NUMERO_CAJA);
    await expectGuard(update(digital.id, { filedAt: new Date() }), SIN_NUMERO_CAJA);
    await expectGuard(prisma.uploadBatch.create({ data: batchData({ boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id }) }), SIN_NUMERO_CAJA);
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: digital.id } }))
      .toMatchObject({ boxLabel: null, returnedAt: null, filedAt: null, filedById: null });

    // «Era papel» y guardarlo en la misma escritura, sí.
    await update(digital.id, { tacoNumber: 91, boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id });
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: digital.id } })).toMatchObject({ tacoNumber: 91, boxLabel: "Caja 1" });
  });

  it("mutante: sin el trigger, una tanda digital se guarda en una caja", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.update({ where: { id: digital.id }, data: { boxLabel: "Caja 1", filedAt: new Date(), filedById: a.worker.id } })))
      .toMatchObject({ tacoNumber: null, boxLabel: "Caja 1" });
  });
});

describe("el papel ubicado a mano (ARCHIVE) lleva nº", () => {
  it("sin nº no entra; con nº sí", async () => {
    await expectGuard(prisma.uploadBatch.create({ data: batchData({ origin: "ARCHIVE", fileCount: 0, tacoNumber: null }) }), ARCHIVE_SIN_NUMERO);
    expect(await prisma.uploadBatch.create({ data: batchData({ origin: "ARCHIVE", fileCount: 0, tacoNumber: 4 }) }))
      .toMatchObject({ origin: "ARCHIVE", tacoNumber: 4 });
  });

  it("mutante: sin el trigger, entra sin nº", async () => {
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.create({ data: batchData({ origin: "ARCHIVE", fileCount: 0, tacoNumber: null }) })))
      .toMatchObject({ origin: "ARCHIVE", tacoNumber: null });
  });
});

describe("el cliente, los candidatos y el PDF son de la asesoría de la tanda", () => {
  it("al crearla: un cliente, un candidato o un PDF de otra asesoría (o de otro cliente) no entran", async () => {
    const otherClientOfA = await prisma.client.create({ data: { name: "Otra SL", cif: "B88888883", advisoryFirmId: a.firm.id } });
    const docOfB = await pdfDocument(b);
    const docOfOtherClient = await pdfDocument(a, otherClientOfA.id);
    const create = (data: Partial<Prisma.UploadBatchUncheckedCreateInput>) => prisma.uploadBatch.create({ data: batchData(data) });
    await expectGuard(create({ clientId: b.client.id }), ASESORIA);
    await expectGuard(create({ clientId: null, routingCandidateIds: [a.client.id, b.client.id] }), ASESORIA);
    await expectGuard(create({ clientId: null, routingCandidateIds: ["no-existe"] }), ASESORIA);
    await expectGuard(create({ clientId: a.client.id, routingCandidateIds: [otherClientOfA.id] }), ASESORIA);
    const whole = { wholePdf: true, tacoNumber: 1, fileCount: 1, pdfPageCount: 3 };
    await expectGuard(create({ ...whole, pdfDocumentId: docOfB.id }), ASESORIA);
    await expectGuard(create({ ...whole, pdfDocumentId: docOfOtherClient.id }), ASESORIA);
    expect(await prisma.uploadBatch.count()).toBe(0);

    // Lo de la asesoría, sí.
    expect(await create({ clientId: null, routingCandidateIds: [a.client.id, otherClientOfA.id] }))
      .toMatchObject({ clientId: null, routingCandidateIds: [a.client.id, otherClientOfA.id] });
    expect(await create({ ...whole, clientId: otherClientOfA.id, pdfDocumentId: docOfOtherClient.id })).toMatchObject({ wholePdf: true });
  });

  it("mutante: sin el trigger, la tanda de A entra con el cliente de B", async () => {
    expect(await withoutTrigger("UploadBatch", "upload_batch_guard",
      (tx) => tx.uploadBatch.create({ data: batchData({ clientId: b.client.id }) }))).toMatchObject({ clientId: b.client.id });
  });
});

describe("la tanda y el taco de una fila de archivo son de su asesoría", () => {
  it("poner la tanda de llegada o el taco del papel de otra asesoría falla; de la misma, no", async () => {
    const id = a.invoices.pending.id;
    const foreignArrival = await makeTaco(b, { tacoNumber: null });
    const foreignTaco = await makeTaco(b, { origin: "ARCHIVE" });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: foreignArrival.id, uploadPosition: 1 } }), OTRA_ASESORIA);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: foreignTaco.id } }), OTRA_ASESORIA);

    const arrival = await makeTaco(a, { tacoNumber: null });
    const taco = await makeTaco(a, { origin: "ARCHIVE" });
    const otherTaco = await makeTaco(a, { origin: "ARCHIVE" });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: arrival.id, uploadPosition: 1 } });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: taco.id } });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: otherTaco.id } });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: foreignTaco.id } }), OTRA_ASESORIA);
    expect(await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } }))
      .toMatchObject({ uploadBatchId: arrival.id, uploadPosition: 1, paperBatchId: otherTaco.id });
  });

  it("una factura del buzón «Sin clasificar» de la asesoría entra en una tanda de varios", async () => {
    const bucket = await prisma.client.create({ data: { name: "Sin clasificar", cif: "B88888884", advisoryFirmId: a.firm.id, isUnclassifiedBucket: true } });
    const invoice = await prisma.invoice.create({
      data: { clientId: bucket.id, filename: "x.pdf", storageKey: `${bucket.id}/x.pdf`, fileType: "application/pdf", type: "PURCHASE", periodMonth: 9, periodYear: 2026, routingCandidateIds: [a.client.id] },
    });
    const several = await makeTaco(a, { clientId: null, candidateIds: [a.client.id] });
    await prisma.invoiceArchive.update({ where: { invoiceId: invoice.id }, data: { uploadBatchId: several.id, uploadPosition: 2 } });
    expect((await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: invoice.id } })).uploadBatchId).toBe(several.id);
  });

  it("mutante: sin el trigger, la fila de A se queda con el taco de B", async () => {
    const foreignTaco = await makeTaco(b, { origin: "ARCHIVE" });
    expect(await withoutTrigger("InvoiceArchive", "archive_batch_firm_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: a.invoices.pending.id }, data: { paperBatchId: foreignTaco.id } })))
      .toMatchObject({ paperBatchId: foreignTaco.id });
  });
});

describe("el papel se pone en un taco con nº", () => {
  it("una tanda digital de la asesoría no vale como taco del papel; la de llegada sí puede ser digital", async () => {
    const id = a.invoices.pending.id;
    const digital = await makeTaco(a, { tacoNumber: null });
    const taco = await makeTaco(a, { origin: "ARCHIVE" });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: digital.id } }), PAPEL_SIN_NUMERO);
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: digital.id, uploadPosition: 1 } });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: taco.id } });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: digital.id } }), PAPEL_SIN_NUMERO);
    expect(await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } }))
      .toMatchObject({ uploadBatchId: digital.id, paperBatchId: taco.id });
    // Convertida en taco («Era papel»), ya sí.
    await update(digital.id, { tacoNumber: 92 });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: digital.id } });
    expect((await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } })).paperBatchId).toBe(digital.id);
  });

  it("mutante: sin el trigger, el papel se queda en una tanda digital", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    expect(await withoutTrigger("InvoiceArchive", "archive_batch_firm_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: a.invoices.pending.id }, data: { paperBatchId: digital.id } })))
      .toMatchObject({ paperBatchId: digital.id });
  });
});
