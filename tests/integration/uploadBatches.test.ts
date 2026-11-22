// Tandas y tacos al subir (entrega B, I1): la acción startUploadBatch y la
// ruta /api/uploads reales, con el S3 falso. Nº de taco correlativo por
// asesoría y a la vez, ficheros con su tanda y su página, reintentos y
// choques, el taco entero en un PDF y quién entra en una tanda (B-R2 a B-R6,
// B-R8, B-R9 y B-R20).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeTaco, makeUser, makeInvoice, type FirmWorld } from "./helpers/factories";
import { facturaeXml, PNG_DATA_URL } from "./helpers/fixtures";
import { signInAs, type TestSessionUser } from "./helpers/session";
import { discardAfterCallbacks, pendingAfterCallbacks, runAfterCallbacks } from "./helpers/after";
import { inFlight, registerLock } from "./helpers/inflight";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { stubOcr } from "./helpers/ocr";
import { DIGITAL_PRODUCER, testPdf } from "./helpers/pdfs";
import { POST as upload } from "@/app/api/uploads/route";
import { startUploadBatch } from "@/app/dashboard/worker/upload/uploadBatchActions";
import { canAccessUploadBatch, uploadBatchVisibleWhere, tacoViewer, visibleClientIds } from "@/lib/archiveAccess";
import { isTacoCreateConflict, TACO_CREATE_CONFLICT_ERROR, TACO_LOCK_NAMESPACE } from "@/lib/uploadBatches";
import { ARCHIVE_EDIT_WAITS } from "@/lib/archiveEdits";
import { ERROR_MESSAGES } from "@/lib/errorCodes";
import { formatDayEs } from "@/lib/dates";
import type { ExtractedInvoice, OcrResult } from "@/lib/ocr";

let a: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pngBytes = () => Buffer.from(PNG_DATA_URL.split(",")[1], "base64");

/** Un PDF de una página distinto en cada llamada (el título lo cambia). */
let pdfSequence = 0;
async function pdf(label = `pdf-${++pdfSequence}`, pages = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let n = 0; n < pages; n++) doc.addPage();
  doc.setTitle(label);
  return Buffer.from(await doc.save());
}

type StartInput = Parameters<typeof startUploadBatch>[0];
const start = (user: TestSessionUser, input: Record<string, unknown> = {}) => {
  signInAs(user);
  return startUploadBatch({
    clientId: a.client.id,
    candidateClientIds: [],
    periodType: "MONTHLY",
    periodMonth: 4,
    periodYear: 2026,
    invoiceType: "PURCHASE",
    fileCount: 3,
    kind: "DIGITAL",
    ...input,
  } satisfies StartInput);
};

async function startOk(user: TestSessionUser, input: Record<string, unknown> = {}) {
  const result = await start(user, input);
  if (!("ok" in result)) throw new Error(`startUploadBatch: ${result.error}`);
  return result;
}

type PostOptions = {
  batch?: { id: string; position: number | string };
  wholeTaco?: boolean;
  clientId?: string;
  candidates?: string[];
  period?: { periodType?: string; periodMonth?: number; periodYear?: number };
  type?: string;
  /** Deja encolado el análisis (after) para ejecutarlo en el test. */
  keepAfter?: boolean;
};

/** POST /api/uploads como `user`, por defecto al lote de abril de 2026 del cliente de A. */
async function post(user: TestSessionUser, name: string, bytes: Buffer, mime: string, options: PostOptions = {}) {
  signInAs(user);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: mime }));
  if (options.candidates) form.set("candidateClientIds", JSON.stringify(options.candidates));
  else form.set("clientId", options.clientId ?? a.client.id);
  form.set("periodType", options.period?.periodType ?? "MONTHLY");
  form.set("periodMonth", String(options.period?.periodMonth ?? 4));
  form.set("periodYear", String(options.period?.periodYear ?? 2026));
  form.set("type", options.type ?? "PURCHASE");
  if (options.batch) {
    form.set("uploadBatchId", options.batch.id);
    form.set("uploadPosition", String(options.batch.position));
  }
  if (options.wholeTaco) form.set("wholeTaco", "1");
  const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
  if (!options.keepAfter) discardAfterCallbacks();
  return { status: res.status, body: await res.json() };
}

const postPdf = async (user: TestSessionUser, options: PostOptions = {}, bytes?: Buffer) =>
  post(user, "escaneo.pdf", bytes ?? await pdf(), "application/pdf", options);

const archiveOf = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });
const batchOf = (id: string) => prisma.uploadBatch.findUniqueOrThrow({ where: { id } });
const tacoNumbers = async (firmId: string) =>
  (await prisma.uploadBatch.findMany({ where: { advisoryFirmId: firmId, tacoNumber: { not: null } }, select: { tacoNumber: true } }))
    .map((t) => t.tacoNumber).sort((x, y) => (x ?? 0) - (y ?? 0));

/** Un taco de abril de 2026 de compras del cliente de A, como los que crea startUploadBatch. */
const aprilTaco = (w: FirmWorld, extra: Parameters<typeof makeTaco>[1] = {}) =>
  makeTaco(w, { period: { periodType: "MONTHLY", periodMonth: 4, periodYear: 2026 }, ...extra });

describe("startUploadBatch", () => {
  it("una tanda digital: sin nº, con cliente, lote, tipo, nº de ficheros y quién la crea; el admin y el gestor del cliente", async () => {
    const byWorker = await startOk(a.worker, { fileCount: 52, invoiceType: "UNKNOWN" });
    expect(byWorker.tacoNumber).toBeNull();
    expect(await batchOf(byWorker.batchId)).toMatchObject({
      advisoryFirmId: a.firm.id, clientId: a.client.id, routingCandidateIds: [], origin: "UPLOAD", createdById: a.worker.id,
      fileCount: 52, periodType: "MONTHLY", periodMonth: 4, periodYear: 2026, invoiceType: "UNKNOWN", tacoNumber: null, wholePdf: false,
    });
    const byAdmin = await startOk(a.admin);
    expect((await batchOf(byAdmin.batchId)).createdById).toBe(a.admin.id);
    // En trimestral se guarda el primer mes del trimestre, como el lote.
    const quarterly = await startOk(a.worker, { periodType: "QUARTERLY", periodMonth: 11 });
    expect(await batchOf(quarterly.batchId)).toMatchObject({ periodType: "QUARTERLY", periodMonth: 10 });
  });

  it("un gestor sin el cliente, otra asesoría y el portal no crean ninguna", async () => {
    const b = await makeFirm("B");
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    expect(await start(stranger)).toEqual({ error: ERROR_MESSAGES["ERR-UPLOAD-005"] });
    expect(await start(b.admin)).toEqual({ error: ERROR_MESSAGES["ERR-UPLOAD-005"] });
    expect(await start(b.worker)).toEqual({ error: ERROR_MESSAGES["ERR-UPLOAD-005"] });
    expect(await start(a.clientUser)).toEqual({ error: ERROR_MESSAGES["ERR-AUTH-002"] });
    expect(await prisma.uploadBatch.count()).toBe(0);
  });

  it("papel: nº 1 y luego 2; otra asesoría empieza en 1; un taco a mano con el 7 hace que el siguiente sea el 8", async () => {
    const b = await makeFirm("B");
    expect((await startOk(a.worker, { kind: "PER_INVOICE" })).tacoNumber).toBe(1);
    expect((await startOk(a.admin, { kind: "PER_INVOICE" })).tacoNumber).toBe(2);
    expect((await startOk(b.worker, { clientId: b.client.id, kind: "PER_INVOICE" })).tacoNumber).toBe(1);
    // Una tanda digital no gasta nº.
    await startOk(a.worker);
    await makeTaco(a, { origin: "ARCHIVE", tacoNumber: 7 });
    expect((await startOk(a.worker, { kind: "PER_INVOICE" })).tacoNumber).toBe(8);
  });

  it("cinco tacos a la vez: 1..5 sin repetir", async () => {
    signInAs(a.worker);
    const input = { clientId: a.client.id, candidateClientIds: [], periodType: "MONTHLY", periodMonth: 4, periodYear: 2026, invoiceType: "PURCHASE", fileCount: 3, kind: "PER_INVOICE" };
    const results = await Promise.all(Array.from({ length: 5 }, () => inFlight(startUploadBatch(input))));
    expect(results.map((r) => ("ok" in r ? r.tacoNumber : r.error)).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await tacoNumbers(a.firm.id)).toEqual([1, 2, 3, 4, 5]);
  });

  describe("con el bloqueo de la asesoría retenido", () => {
    const defaultLockTimeout = ARCHIVE_EDIT_WAITS.lockTimeoutMs;
    afterEach(() => {
      ARCHIVE_EDIT_WAITS.lockTimeoutMs = defaultLockTimeout;
    });

    it("más que el lock_timeout: «Otra persona estaba creando un taco» y ninguna tanda", async () => {
      ARCHIVE_EDIT_WAITS.lockTimeoutMs = 300;
      const lock = await holdLock(`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}, hashtext($1))`, a.firm.id);
      try {
        expect(await start(a.worker, { kind: "PER_INVOICE" })).toEqual({ error: TACO_CREATE_CONFLICT_ERROR });
      } finally {
        await lock.release();
      }
      expect(await prisma.uploadBatch.count()).toBe(0);
      // La otra asesoría no espera: su bloqueo es otro.
      const b = await makeFirm("B");
      const other = await holdLock(`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}, hashtext($1))`, a.firm.id);
      try {
        expect((await startOk(b.worker, { clientId: b.client.id, kind: "PER_INVOICE" })).tacoNumber).toBe(1);
      } finally {
        await other.release();
      }
    });
  });

  it("isTacoCreateConflict reconoce el unique del nº (dos tacos con el mismo nº)", async () => {
    await makeTaco(a, { tacoNumber: 3 });
    const err = await makeTaco(a, { tacoNumber: 3 }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isTacoCreateConflict(err)).toBe(true);
    expect(isTacoCreateConflict(new Error("otra cosa"))).toBe(false);
  });

  it("periodo cerrado, sin ficheros, más de 500 o el taco entero: { error } y ninguna tanda", async () => {
    await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 4, year: 2026, closedBy: a.admin.id } });
    expect(await start(a.worker)).toEqual({ error: ERROR_MESSAGES["ERR-UPLOAD-004"] });
    expect(await start(a.worker, { periodMonth: 5, fileCount: 0 })).toEqual({ error: "La subida no tiene ficheros." });
    expect(await start(a.worker, { periodMonth: 5, fileCount: 501 })).toEqual({ error: "Como mucho 500 ficheros por subida." });
    expect(await start(a.worker, { periodMonth: 5, fileCount: 501, kind: "PER_INVOICE" }))
      .toEqual({ error: "Como mucho 500 ficheros por taco: pártelo en dos." });
    expect(await start(a.worker, { periodMonth: 5, kind: "WHOLE_PDF" })).toEqual({ error: "La subida no vale. Recarga la página." });
    expect(await start(a.worker, { periodMonth: 5, candidateClientIds: [a.client.id] }))
      .toEqual({ error: "Elige un cliente o las empresas entre las que clasificar." });
    expect(await prisma.uploadBatch.count()).toBe(0);
    expect((await startOk(a.worker, { periodMonth: 5, fileCount: 500, kind: "PER_INVOICE" })).tacoNumber).toBe(1);
  });

  it("clasificar entre varios: guarda los candidatos; uno sin acceso, { error }", async () => {
    const second = await prisma.client.create({ data: { name: "Segunda SL", cif: "B77777771", advisoryFirmId: a.firm.id } });
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: second.id } });
    const third = await prisma.client.create({ data: { name: "Tercera SL", cif: "B77777772", advisoryFirmId: a.firm.id } });
    const several = await startOk(a.worker, { clientId: null, candidateClientIds: [a.client.id, second.id], kind: "PER_INVOICE" });
    expect(await batchOf(several.batchId)).toMatchObject({ clientId: null, routingCandidateIds: [a.client.id, second.id], tacoNumber: 1 });
    expect(await start(a.worker, { clientId: null, candidateClientIds: [a.client.id, third.id] }))
      .toEqual({ error: ERROR_MESSAGES["ERR-UPLOAD-005"] });
    expect(await prisma.uploadBatch.count()).toBe(1);
  });
});

describe("/api/uploads con tanda", () => {
  it("un taco de ficheros que llegan en desorden: cada factura con su página, la llegada de la tanda y papel desde el alta", async () => {
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    const createdAt = (await batchOf(taco.batchId)).createdAt;
    const results = await Promise.all([3, 1, 2].map(async (position) =>
      ({ position, ...(await inFlight(postPdf(a.worker, { batch: { id: taco.batchId, position } }))) })));
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(await archiveOf(result.body.invoiceId)).toMatchObject({
        uploadBatchId: taco.batchId, uploadPosition: result.position, splitPart: 0, receivedAt: createdAt,
        originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco", paperHeldByClient: false,
      });
    }
    // Una foto en una tanda digital sigue «Por confirmar», con la llegada de la tanda.
    const digital = await startOk(a.worker);
    const photo = await post(a.worker, "foto.png", pngBytes(), "image/png", { batch: { id: digital.batchId, position: 2 } });
    expect(photo.status).toBe(200);
    expect(await archiveOf(photo.body.invoiceId)).toMatchObject({
      uploadBatchId: digital.batchId, uploadPosition: 2, receivedAt: (await batchOf(digital.batchId)).createdAt,
      originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "image_unconfirmed",
    });
  });

  it("en un taco, un PDF con texto sigue siendo papel después del análisis; en una tanda digital, electrónico", async () => {
    const reply = (): OcrResult => ({
      rawJson: "{}",
      extracted: {
        issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: a.client.name, receiverCif: a.client.cif,
        invoiceNumber: "F-1", invoiceDate: "2026-04-10", taxBase: 100, vatRate: 21, vatAmount: 21,
        irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
        vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
      } as ExtractedInvoice,
    });
    stubOcr(async () => reply());
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    const digital = await startOk(a.worker);
    const inTaco = await postPdf(a.worker, { batch: { id: taco.batchId, position: 1 }, keepAfter: true },
      await testPdf({ text: true, producer: DIGITAL_PRODUCER }));
    const inDigital = await postPdf(a.worker, { batch: { id: digital.batchId, position: 1 }, keepAfter: true },
      await testPdf({ text: true, producer: `${DIGITAL_PRODUCER} (2)` }));
    expect([inTaco.status, inDigital.status]).toEqual([200, 200]);
    await runAfterCallbacks();
    expect(await archiveOf(inTaco.body.invoiceId)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" });
    expect(await archiveOf(inDigital.body.invoiceId)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });
  });

  it("el mismo fichero otra vez en su página: 200 con la misma factura, sin crear otra ni dejar el objeto del reintento", async () => {
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    const bytes = await pdf();
    const first = await postPdf(a.worker, { batch: { id: taco.batchId, position: 2 } }, bytes);
    const keys = fakeS3().keys();
    const again = await postPdf(a.worker, { batch: { id: taco.batchId, position: 2 } }, bytes);
    expect(first).toMatchObject({ status: 200 });
    expect(again).toEqual({ status: 200, body: { invoiceId: first.body.invoiceId, filename: "escaneo.pdf", alreadyUploaded: true } });
    expect(await prisma.invoice.count({ where: { fileHash: sha256(bytes) } })).toBe(1);
    expect(fakeS3().keys()).toEqual(keys);
  });

  it("un reintento que ve la página libre y, antes de buscar el duplicado, se registra el primer intento: 200 alreadyUploaded, no «duplicada»", async () => {
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    const bytes = await pdf();
    // El primer intento, registrado sin confirmar y con la tabla de facturas
    // bloqueada: el reintento ve la página libre (la fila aún no se ve) y se
    // para al buscar el duplicado hasta que el primero confirma.
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => (commit = resolve));
    let registered!: (invoiceId: string) => void;
    const firstInvoiceId = new Promise<string>((resolve) => (registered = resolve));
    const first = inFlight(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "Invoice" IN ACCESS EXCLUSIVE MODE`);
      const invoice = await tx.invoice.create({
        data: {
          clientId: a.client.id, filename: "escaneo.pdf", storageKey: `${a.client.id}/2026-04/escaneo-primero.pdf`,
          fileType: "application/pdf", fileHash: sha256(bytes), type: "PURCHASE", periodType: "MONTHLY", periodMonth: 4, periodYear: 2026,
        },
        select: { id: true },
      });
      await tx.invoiceArchive.update({ where: { invoiceId: invoice.id }, data: { uploadBatchId: taco.batchId, uploadPosition: 1 } });
      registered(invoice.id);
      await committed;
    }, { timeout: 20_000, maxWait: 10_000 }));
    const unregister = registerLock(async () => {
      commit();
      await first.catch(() => {});
    });
    const invoiceId = await firstInvoiceId;

    const retry = inFlight(postPdf(a.worker, { batch: { id: taco.batchId, position: 1 } }, bytes));
    for (let i = 0; i < 100 && (await sessionsWaitingForLock()) < 1; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await sessionsWaitingForLock()).toBe(1);
    unregister();
    commit();
    await first;

    expect(await retry).toEqual({ status: 200, body: { invoiceId, filename: "escaneo.pdf", alreadyUploaded: true } });
    expect(await prisma.invoice.count({ where: { fileHash: sha256(bytes) } })).toBe(1);
    expect(fakeS3().keys()).toEqual([]);
  });

  it("otro fichero en una página ocupada: 409 ERR-UPLOAD-009 y nada nuevo en el S3", async () => {
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    expect((await postPdf(a.worker, { batch: { id: taco.batchId, position: 1 } })).status).toBe(200);
    const keys = fakeS3().keys();
    const other = await postPdf(a.worker, { batch: { id: taco.batchId, position: 1 } });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("ERR-UPLOAD-009");
    expect(fakeS3().keys()).toEqual(keys);
  });

  it("ERR-UPLOAD-008 (409) y nada en el S3 si la tanda no admite el fichero", async () => {
    const b = await makeFirm("B");
    const second = await prisma.client.create({ data: { name: "Segunda SL", cif: "B77777773", advisoryFirmId: a.firm.id } });
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: second.id } });
    const taco = await aprilTaco(a, { fileCount: 3 });
    const several = await aprilTaco(a, { clientId: null, candidateIds: [a.client.id, second.id] });
    const cases: { label: string; options: PostOptions }[] = [
      { label: "otra asesoría", options: { batch: { id: (await aprilTaco(b)).id, position: 1 } } },
      { label: "no existe", options: { batch: { id: "no-existe", position: 1 } } },
      { label: "posición 0", options: { batch: { id: taco.id, position: 0 } } },
      { label: "posición fileCount + 1", options: { batch: { id: taco.id, position: 4 } } },
      {
        label: "digital de hace 25 h",
        options: { batch: { id: (await aprilTaco(a, { tacoNumber: null, createdAt: new Date(Date.now() - 25 * 3600_000) })).id, position: 1 } },
      },
      { label: "otro cliente", options: { clientId: second.id, batch: { id: taco.id, position: 1 } } },
      { label: "otro periodo", options: { period: { periodMonth: 5 }, batch: { id: taco.id, position: 1 } } },
      { label: "otra agrupación", options: { period: { periodType: "QUARTERLY" }, batch: { id: taco.id, position: 1 } } },
      { label: "otro tipo", options: { type: "SALE", batch: { id: taco.id, position: 1 } } },
      { label: "tanda de un cliente en modo clasificar", options: { candidates: [a.client.id], batch: { id: taco.id, position: 1 } } },
      { label: "tanda de varios con un cliente", options: { batch: { id: several.id, position: 1 } } },
      { label: "un candidato que no es de la tanda", options: { candidates: [a.client.id, second.id], batch: { id: (await aprilTaco(a, { clientId: null, candidateIds: [a.client.id] })).id, position: 1 } } },
      { label: "taco anulado", options: { batch: { id: (await aprilTaco(a, { voided: { reason: "Vacío" } })).id, position: 1 } } },
      { label: "taco entero", options: { batch: { id: (await aprilTaco(a, { wholePdf: { pageCount: 3 } })).id, position: 1 } } },
      { label: "papel ubicado a mano", options: { batch: { id: (await makeTaco(a, { origin: "ARCHIVE" })).id, position: 1 } } },
    ];
    for (const { label, options } of cases) {
      const res = await postPdf(a.worker, options);
      expect([label, res.status, res.body.error?.code]).toEqual([label, 409, "ERR-UPLOAD-008"]);
    }
    expect(fakeS3().keys()).toEqual([]);
    expect(await prisma.invoice.count()).toBe(2 + 2);

    // Un taco no caduca: uno de hace 25 h sí admite su página libre.
    const old = await aprilTaco(a, { createdAt: new Date(Date.now() - 25 * 3600_000) });
    expect((await postPdf(a.worker, { batch: { id: old.id, position: 2 } })).status).toBe(200);
  });

  it("otro gestor con el cliente completa un hueco de un taco que no creó; uno sin el cliente, 403 ERR-UPLOAD-005", async () => {
    const colleague = await makeUser(a.firm.id, "WORKER", "colega");
    await prisma.workerClientAssignment.create({ data: { workerId: colleague.id, clientId: a.client.id } });
    const stranger = await makeUser(a.firm.id, "WORKER", "extrano");
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    expect((await postPdf(colleague, { batch: { id: taco.batchId, position: 3 } })).status).toBe(200);
    const denied = await postPdf(stranger, { batch: { id: taco.batchId, position: 2 } });
    expect([denied.status, denied.body.error.code]).toEqual([403, "ERR-UPLOAD-005"]);
    expect((await postPdf(a.admin, { batch: { id: taco.batchId, position: 2 } })).status).toBe(200);
  });

  it("el portal (CLIENT) con tanda o con taco entero: 403 ERR-UPLOAD-008", async () => {
    const taco = await aprilTaco(a);
    const withBatch = await postPdf(a.clientUser, { batch: { id: taco.id, position: 1 } });
    const whole = await postPdf(a.clientUser, { wholeTaco: true });
    expect([withBatch.status, withBatch.body.error.code]).toEqual([403, "ERR-UPLOAD-008"]);
    expect([whole.status, whole.body.error.code]).toEqual([403, "ERR-UPLOAD-008"]);
    expect(fakeS3().keys()).toEqual([]);
  });

  it("tanda sin posición, posición sin tanda o taco entero con tanda: 400", async () => {
    const taco = await aprilTaco(a);
    signInAs(a.worker);
    for (const fields of [{ uploadBatchId: taco.id }, { uploadPosition: "1" }, { uploadBatchId: taco.id, uploadPosition: "1", wholeTaco: "1" }, { uploadBatchId: taco.id, uploadPosition: "uno" }]) {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(await pdf())], "x.pdf", { type: "application/pdf" }));
      form.set("clientId", a.client.id);
      form.set("periodType", "MONTHLY");
      form.set("periodMonth", "4");
      form.set("periodYear", "2026");
      form.set("type", "PURCHASE");
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
      expect(res.status).toBe(400);
    }
  });

  it("un XML en un taco: 415 ERR-UPLOAD-010 y nada en el S3; en una tanda digital, sí", async () => {
    const taco = await aprilTaco(a);
    const xml = Buffer.from(facturaeXml());
    const res = await post(a.worker, "factura.xml", xml, "application/xml", { batch: { id: taco.id, position: 1 } });
    expect([res.status, res.body.error.code]).toEqual([415, "ERR-UPLOAD-010"]);
    expect(fakeS3().keys()).toEqual([]);
    const digital = await aprilTaco(a, { tacoNumber: null });
    expect((await post(a.worker, "factura.xml", xml, "application/xml", { batch: { id: digital.id, position: 1 } })).status).toBe(200);
  });

  it("clasificar entre varios con una tanda de varios: entra en el buzón con su tanda y su página, también con parte de los candidatos", async () => {
    const second = await prisma.client.create({ data: { name: "Segunda SL", cif: "B77777774", advisoryFirmId: a.firm.id } });
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: second.id } });
    const several = await startOk(a.worker, { clientId: null, candidateClientIds: [a.client.id, second.id], kind: "PER_INVOICE" });
    const all = await postPdf(a.worker, { candidates: [a.client.id, second.id], batch: { id: several.batchId, position: 1 } });
    const part = await postPdf(a.worker, { candidates: [second.id], batch: { id: several.batchId, position: 2 } });
    expect([all.status, part.status]).toEqual([200, 200]);
    for (const [result, position] of [[all, 1], [part, 2]] as const) {
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.body.invoiceId }, include: { client: true, archive: true } });
      expect(invoice.client.isUnclassifiedBucket).toBe(true);
      expect(invoice.archive).toMatchObject({ uploadBatchId: several.batchId, uploadPosition: position, originalMediumSource: "TACO" });
    }
  });

  describe("dos subidas a la vez a la misma página", () => {
    /** Las dos pasan la comprobación previa y esperan al FOR SHARE de la tanda; al soltarla, choca el unique. */
    async function race(bytesA: Buffer, bytesB: Buffer) {
      const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
      const lock = await holdLock(`SELECT 1 FROM "UploadBatch" WHERE "id" = $1 FOR UPDATE`, taco.batchId);
      const both = [bytesA, bytesB].map((bytes) => inFlight(postPdf(a.worker, { batch: { id: taco.batchId, position: 1 } }, bytes)));
      for (let i = 0; i < 100 && (await sessionsWaitingForLock()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await sessionsWaitingForLock()).toBe(2);
      await lock.release();
      return Promise.all(both);
    }

    it("con ficheros distintos: una 200 y otra 409 ERR-UPLOAD-009; una factura y en el S3 solo su objeto", async () => {
      const results = await race(await pdf(), await pdf());
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.error.code).toBe("ERR-UPLOAD-009");
      const winner = await prisma.invoice.findUniqueOrThrow({ where: { id: results.find((r) => r.status === 200)?.body.invoiceId } });
      expect(await prisma.invoiceArchive.count({ where: { uploadPosition: 1 } })).toBe(1);
      expect(await prisma.invoice.count()).toBe(3);
      expect(fakeS3().keys()).toEqual([winner.storageKey]);
      // Sin ticket automático: es un choque esperado.
      expect(await prisma.supportTicket.count()).toBe(0);
    });

    it("con el mismo fichero: las dos 200 con la misma factura (la segunda, alreadyUploaded)", async () => {
      const bytes = await pdf();
      const results = await race(bytes, bytes);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(new Set(results.map((r) => r.body.invoiceId)).size).toBe(1);
      expect(results.filter((r) => r.body.alreadyUploaded)).toHaveLength(1);
      expect(fakeS3().keys()).toHaveLength(1);
    });
  });

  it("un fichero con la huella de una factura del cliente: { duplicate: true } y su página se queda vacía", async () => {
    const bytes = await pdf();
    await makeInvoice(a.client, { fileHash: sha256(bytes) });
    const taco = await aprilTaco(a);
    const res = await postPdf(a.worker, { batch: { id: taco.id, position: 2 } }, bytes);
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(await prisma.invoiceArchive.count({ where: { uploadBatchId: taco.id } })).toBe(0);
    expect(fakeS3().keys()).toEqual([]);
  });

  it("una anulación que llega antes que el alta: 409 ERR-UPLOAD-008 y el objeto se borra", async () => {
    const taco = await startOk(a.worker, { kind: "PER_INVOICE" });
    const lock = await holdLock(`SELECT 1 FROM "UploadBatch" WHERE "id" = $1 FOR UPDATE`, taco.batchId);
    const pending = inFlight(postPdf(a.worker, { batch: { id: taco.batchId, position: 1 } }));
    for (let i = 0; i < 100 && (await sessionsWaitingForLock()) < 1; i++) await new Promise((r) => setTimeout(r, 50));
    await lock.release(`UPDATE "UploadBatch" SET "voidedAt" = now(), "voidedById" = 'alguien', "voidReason" = 'Vacío' WHERE "id" = $1`);
    const res = await pending;
    expect([res.status, res.body.error?.code]).toEqual([409, "ERR-UPLOAD-008"]);
    expect(fakeS3().keys()).toEqual([]);
    expect(await prisma.invoiceArchive.count({ where: { uploadBatchId: taco.batchId } })).toBe(0);
  });
});

describe("/api/uploads con el taco entero (wholeTaco=1)", () => {
  it("un PDF de 7 páginas crea el taco con su Document, sin factura ni análisis", async () => {
    const bytes = await testPdf({ pages: 7 });
    const invoicesBefore = await prisma.invoice.count();
    const res = await postPdf(a.worker, { wholeTaco: true, keepAfter: true }, bytes);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tacoPdf: true, batchId: expect.any(String), tacoNumber: 1, pageCount: 7 });
    expect(pendingAfterCallbacks()).toBe(0);
    expect(await prisma.invoice.count()).toBe(invoicesBefore);
    const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: res.body.batchId }, include: { pdfDocument: true } });
    expect(batch).toMatchObject({
      advisoryFirmId: a.firm.id, clientId: a.client.id, origin: "UPLOAD", createdById: a.worker.id, tacoNumber: 1,
      wholePdf: true, fileCount: 1, pdfPageCount: 7, pdfSplitAt: null, periodType: "MONTHLY", periodMonth: 4, periodYear: 2026,
      invoiceType: "PURCHASE",
    });
    expect(batch.pdfDocument).toMatchObject({
      clientId: a.client.id, uploadedBy: a.worker.id, fileHash: sha256(bytes), sizeBytes: bytes.length, fileType: "application/pdf",
    });
    expect(fakeS3().keys()).toEqual([batch.pdfDocument!.storageKey]);
  });

  it("el reintento del mismo PDF responde con el mismo taco; en otro cliente o lote es un duplicado; tras anular, entra", async () => {
    const second = await prisma.client.create({ data: { name: "Segunda SL", cif: "B77777775", advisoryFirmId: a.firm.id } });
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: second.id } });
    const bytes = await testPdf({ pages: 3 });
    const first = await postPdf(a.worker, { wholeTaco: true }, bytes);
    const retry = await postPdf(a.worker, { wholeTaco: true }, bytes);
    expect(retry).toEqual({ status: 200, body: { tacoPdf: true, batchId: first.body.batchId, tacoNumber: 1, pageCount: 3, alreadyUploaded: true } });
    expect(await prisma.document.count({ where: { fileHash: sha256(bytes) } })).toBe(1);
    expect(fakeS3().keys()).toHaveLength(1);

    const day = formatDayEs((await batchOf(first.body.batchId)).createdAt);
    const of = `el PDF del Taco 1 (subido el ${day})`;
    expect((await postPdf(a.worker, { wholeTaco: true, clientId: second.id }, bytes)).body).toEqual({ duplicate: true, of });
    expect((await postPdf(a.worker, { wholeTaco: true, period: { periodMonth: 5 } }, bytes)).body).toEqual({ duplicate: true, of });
    expect((await postPdf(a.worker, { wholeTaco: true, type: "SALE" }, bytes)).body).toEqual({ duplicate: true, of });
    expect(await tacoNumbers(a.firm.id)).toEqual([1]);

    await prisma.uploadBatch.update({
      where: { id: first.body.batchId },
      data: { voidedAt: new Date(), voidedById: a.worker.id, voidReason: "Subido al cliente equivocado" },
    });
    const again = await postPdf(a.worker, { wholeTaco: true, clientId: second.id }, bytes);
    expect(again.body).toMatchObject({ tacoPdf: true, tacoNumber: 2, pageCount: 3 });
    expect(again.body.alreadyUploaded).toBeUndefined();
  });

  it("una imagen, un PDF roto, uno con contraseña o uno de 501 páginas: 415 ERR-UPLOAD-011, nada en el S3 y ningún nº gastado", async () => {
    const encrypted = await PDFDocument.create();
    encrypted.addPage();
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: "Standard", V: 1, R: 2, P: -44 }));
    const files: [string, Buffer, string][] = [
      ["foto.png", pngBytes(), "image/png"],
      ["roto.pdf", Buffer.from("%PDF-1.4\nbasura sin estructura\n"), "application/pdf"],
      ["cifrado.pdf", Buffer.from(await encrypted.save({ useObjectStreams: false })), "application/pdf"],
      ["enorme.pdf", await testPdf({ pages: 501 }), "application/pdf"],
    ];
    for (const [name, bytes, mime] of files) {
      const res = await post(a.worker, name, bytes, mime, { wholeTaco: true });
      expect([name, res.status, res.body.error?.code]).toEqual([name, 415, "ERR-UPLOAD-011"]);
    }
    expect(fakeS3().keys()).toEqual([]);
    expect(await prisma.uploadBatch.count()).toBe(0);
    expect((await postPdf(a.worker, { wholeTaco: true }, await testPdf({ pages: 500 }))).body.tacoNumber).toBe(1);
  });

  it("en modo clasificar, 400; con el periodo cerrado, 409 con su texto", async () => {
    const res = await postPdf(a.worker, { wholeTaco: true, candidates: [a.client.id] });
    expect([res.status, res.body.error.code]).toEqual([400, "ERR-UPLOAD-005"]);
    await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 4, year: 2026, closedBy: a.admin.id } });
    const closed = await postPdf(a.worker, { wholeTaco: true });
    expect([closed.status, closed.body.error.code, closed.body.error.message]).toEqual([409, "ERR-UPLOAD-004", ERROR_MESSAGES["ERR-UPLOAD-004"]]);
    expect(await prisma.uploadBatch.count()).toBe(0);
  });

  it("dos tacos enteros a la vez (PDF distintos): T1 y T2", async () => {
    const [x, y] = await Promise.all([await pdf("uno", 2), await pdf("dos", 3)].map((bytes) => inFlight(postPdf(a.worker, { wholeTaco: true }, bytes))));
    expect([x.body.tacoNumber, y.body.tacoNumber].sort()).toEqual([1, 2]);
  });

  it("el mismo PDF dos veces a la vez: un solo taco y el otro responde como reintento", async () => {
    const bytes = await pdf("doble clic", 2);
    const results = await Promise.all([bytes, bytes].map((b) => inFlight(postPdf(a.worker, { wholeTaco: true }, b))));
    expect(new Set(results.map((r) => r.body.batchId)).size).toBe(1);
    expect(results.filter((r) => r.body.alreadyUploaded)).toHaveLength(1);
    expect(await prisma.uploadBatch.count()).toBe(1);
    expect(fakeS3().keys()).toHaveLength(1);
  });
});

describe("quién entra en una tanda (B-R20)", () => {
  it("de varios: el que la creó, el gestor de uno de sus candidatos o del cliente de una de sus facturas; nadie más", async () => {
    const b = await makeFirm("B");
    const second = await prisma.client.create({ data: { name: "Segunda SL", cif: "B77777776", advisoryFirmId: a.firm.id } });
    const third = await prisma.client.create({ data: { name: "Tercera SL", cif: "B77777777", advisoryFirmId: a.firm.id } });
    const creator = await makeUser(a.firm.id, "WORKER", "creador");
    const ofCandidate = await makeUser(a.firm.id, "WORKER", "decandidato");
    await prisma.workerClientAssignment.create({ data: { workerId: ofCandidate.id, clientId: second.id } });
    const ofInvoice = await makeUser(a.firm.id, "WORKER", "defactura");
    await prisma.workerClientAssignment.create({ data: { workerId: ofInvoice.id, clientId: third.id } });
    const nobody = await makeUser(a.firm.id, "WORKER", "nadie");

    const several = await makeTaco(a, { clientId: null, candidateIds: [second.id], createdById: creator.id });
    // Una factura que llegó en la tanda y ya se ha clasificado al tercer cliente.
    const routed = await makeInvoice({ id: third.id });
    await prisma.invoiceArchive.update({ where: { invoiceId: routed.id }, data: { uploadBatchId: several.id, uploadPosition: 1 } });

    const expected: [TestSessionUser, boolean][] = [
      [a.admin, true], [creator, true], [ofCandidate, true], [ofInvoice, true], [nobody, false], [a.worker, false],
      [b.admin, false], [b.worker, false], [a.clientUser, false],
    ];
    for (const [user, allowed] of expected) {
      expect([user.id, await canAccessUploadBatch({ user }, several.id)]).toEqual([user.id, allowed]);
      const viewer = await tacoViewer({ user });
      const listed = viewer ? await prisma.uploadBatch.count({ where: { AND: [{ id: several.id }, uploadBatchVisibleWhere(viewer)] } }) : 0;
      expect([user.id, listed]).toEqual([user.id, allowed ? 1 : 0]);
    }

    // Por el papel: una factura de otro cliente cuyo papel está en un taco de varios.
    const paperTaco = await makeTaco(a, { clientId: null, origin: "ARCHIVE", createdById: a.admin.id });
    expect(await canAccessUploadBatch({ user: ofInvoice }, paperTaco.id)).toBe(false);
    const paper = await makeInvoice({ id: third.id });
    await prisma.invoiceArchive.update({ where: { invoiceId: paper.id }, data: { paperBatchId: paperTaco.id } });
    expect(await canAccessUploadBatch({ user: ofInvoice }, paperTaco.id)).toBe(true);
  });

  it("con cliente: el gestor que la creó y al que después le quitan el cliente ya no entra", async () => {
    const taco = await makeTaco(a, { createdById: a.worker.id });
    expect(await canAccessUploadBatch({ user: a.worker }, taco.id)).toBe(true);
    await prisma.workerClientAssignment.deleteMany({ where: { workerId: a.worker.id, clientId: a.client.id } });
    expect(await canAccessUploadBatch({ user: a.worker }, taco.id)).toBe(false);
    const viewer = await tacoViewer({ user: a.worker });
    expect(await prisma.uploadBatch.count({ where: uploadBatchVisibleWhere(viewer!) })).toBe(0);
    expect(await canAccessUploadBatch({ user: a.admin }, taco.id)).toBe(true);
  });

  it("visibleClientIds: el admin, todos; el gestor, los suyos de la asesoría; el portal, ninguno", async () => {
    const b = await makeFirm("B");
    // Una asignación a un cliente de otra asesoría (dato corrupto) no cuenta.
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: b.client.id } });
    expect(await visibleClientIds({ user: a.admin })).toBe("all");
    expect(await visibleClientIds({ user: a.worker })).toEqual(new Set([a.client.id]));
    expect(await visibleClientIds({ user: a.clientUser })).toEqual(new Set());
  });
});
