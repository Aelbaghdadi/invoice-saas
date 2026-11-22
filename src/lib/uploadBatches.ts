/**
 * Tandas de subida (B-R2 a B-R6 y B-R9). Cada «Subir» del gestor crea una, que
 * fija la llegada y el orden de lo que se sube junto. Un taco (papel escaneado
 * en la asesoría) lleva además un nº correlativo por asesoría. El taco entero
 * en un PDF no se crea aquí al pulsar «Subir»: nace en /api/uploads con su PDF
 * (createWholeTaco), para que una subida fallida no gaste ningún nº.
 *
 * El portal (CLIENT) no usa tandas.
 */
import { Prisma, type PeriodType } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { appError, ERROR_MESSAGES, type AppError } from "@/lib/errorCodes";
import { assertUploadClientAccess, assertUploadPeriodOpen } from "@/lib/uploadAccess";
import { storedPeriodMonth } from "@/lib/batchTarget";
import { isLockWaitError, isTransactionConflictError, postgresErrorCode } from "@/lib/exportConflict";
import { ARCHIVE_EDIT_WAITS } from "@/lib/archiveEdits";
import { deleteObject, putObject, sanitizeFilenameForStorage } from "@/lib/storage";
import { uploadStorageKey } from "@/lib/uploadStorageKey";
import { formatDayEs } from "@/lib/dates";
import { recordAutoTicket } from "@/lib/autoTickets";
import { TACO_PDF_MAX_PAGES } from "@/lib/tacoSplitPlan";

/** Ficheros de una tanda, como mucho: una subida digital mayor va en varias. */
export const UPLOAD_BATCH_MAX_FILES = 500;
/** Una tanda digital admite sus ficheros durante un día; un taco no caduca. */
export const DIGITAL_BATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** Primera clave del bloqueo de la asesoría al reservar un nº de taco
 *  (48048 es el de la cadena de auditoría). */
export const TACO_LOCK_NAMESPACE = 48_049;

/** DIGITAL: sin nº. PER_INVOICE: taco de factura a factura. */
export type UploadBatchKind = "DIGITAL" | "PER_INVOICE";

export type UploadSession = { user: { id: string; role: string; advisoryFirmId?: string | null } };

export type StartUploadBatchInput = {
  /** null = clasificar entre varios. */
  clientId: string | null;
  /** Solo con clientId null; se guardan en routingCandidateIds. */
  candidateClientIds: string[];
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  invoiceType: "PURCHASE" | "SALE" | "UNKNOWN";
  fileCount: number;
  kind: UploadBatchKind;
};

export const TACO_CREATE_CONFLICT_ERROR = "Otra persona estaba creando un taco; vuelve a pulsar «Subir».";
const START_FAILED = "No se ha podido empezar la subida. Inténtalo de nuevo.";
const NO_FILES = "La subida no tiene ficheros.";
const DIGITAL_TOO_BIG = `Como mucho ${UPLOAD_BATCH_MAX_FILES} ficheros por subida.`;
const TACO_TOO_BIG = `Como mucho ${UPLOAD_BATCH_MAX_FILES} ficheros por taco: pártelo en dos.`;
const CLIENT_OR_CANDIDATES = "Elige un cliente o las empresas entre las que clasificar.";

/** Crear una tanda es corto; el margen es para la espera del bloqueo. */
const BATCH_TRANSACTION = { timeout: 15_000, maxWait: 5_000 } as const;

/** SET LOCAL lock_timeout: si otra transacción retiene el bloqueo de la
 *  asesoría, mejor avisar pronto que esperar al statement_timeout. */
async function setLockTimeout(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${ARCHIVE_EDIT_WAITS.lockTimeoutMs}ms`}, true)`;
}

/**
 * Siguiente nº de taco de la asesoría, dentro de la transacción que lo pone
 * (B-R3). Dos sentencias: en READ COMMITTED cada una ve lo confirmado al
 * empezar, así que en una sola el MAX se leería antes de tener el bloqueo y
 * dos tacos a la vez sacarían el mismo nº. El bloqueo dura hasta el final de
 * la transacción: tomadlo justo antes de escribir la tanda.
 */
export async function reserveTacoNumber(tx: Prisma.TransactionClient, firmId: string): Promise<number> {
  // executeRaw: pg_advisory_xact_lock devuelve void, que queryRaw no sabe leer.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}::int, hashtext(${firmId}::text))`;
  const [row] = await tx.$queryRaw<{ next: number }[]>`
    SELECT (COALESCE(MAX("tacoNumber"), 0) + 1)::int AS next FROM "UploadBatch" WHERE "advisoryFirmId" = ${firmId}`;
  return row.next;
}

/** Campos (o índice) de un unique violado; null si el error es otro. Con
 *  adapter-pg vienen en meta.driverAdapterError, no en meta.target. */
function uniqueViolation(err: unknown): string[] | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (err.code !== "P2002" && postgresErrorCode(err) !== "23505") return null;
  const meta = err.meta as
    | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown } } } }
    | undefined;
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  const raw = constraint?.fields ?? constraint?.index ?? meta?.target;
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return list.map((field) => String(field).replace(/"/g, ""));
}

/** ¿Es un error de crear tacos a la vez? Una espera larga del bloqueo de la
 *  asesoría (55P03, 57014), un interbloqueo (40P01) o el unique del nº. */
export function isTacoCreateConflict(err: unknown): boolean {
  if (isLockWaitError(err) || isTransactionConflictError(err)) return true;
  return uniqueViolation(err)?.some((field) => field.includes("tacoNumber")) ?? false;
}

/** ¿Ha chocado con el unique (tanda, posición, parte) de la fila de archivo?
 *  Dos subidas a la misma página a la vez (B-R5). */
export function isUploadPositionTaken(err: unknown): boolean {
  return uniqueViolation(err)?.some((field) => field.includes("uploadPosition")) ?? false;
}

export type CreateUploadBatchResult =
  | { ok: true; batch: { id: string; tacoNumber: number | null; createdAt: Date } }
  | { ok: false; error: string };

/**
 * La tanda de un «Subir» del gestor (B-R2): digital o taco de factura a
 * factura. Mismas comprobaciones que la subida de cada fichero (acceso al
 * cliente o a cada candidato y, con un cliente, el periodo abierto), para no
 * crear tandas que después no admiten ningún fichero. Nunca lanza.
 */
export async function createUploadBatch(
  session: UploadSession,
  input: StartUploadBatchInput,
): Promise<CreateUploadBatchResult> {
  try {
    const { id: userId, role, advisoryFirmId: firmId } = session.user;
    if ((role !== "ADMIN" && role !== "WORKER") || !firmId) return { ok: false, error: ERROR_MESSAGES["ERR-AUTH-002"] };
    const taco = input.kind === "PER_INVOICE";
    if (!Number.isInteger(input.fileCount) || input.fileCount < 1) return { ok: false, error: NO_FILES };
    if (input.fileCount > UPLOAD_BATCH_MAX_FILES) return { ok: false, error: taco ? TACO_TOO_BIG : DIGITAL_TOO_BIG };

    const candidates = [...new Set(input.candidateClientIds)];
    if (input.clientId ? candidates.length > 0 : candidates.length === 0) return { ok: false, error: CLIENT_OR_CANDIDATES };
    for (const clientId of input.clientId ? [input.clientId] : candidates) {
      const access = await assertUploadClientAccess(session, clientId);
      if (!access.ok) return { ok: false, error: access.error.message };
    }
    const periodMonth = storedPeriodMonth(input.periodType, input.periodMonth);
    if (input.clientId) {
      const open = await assertUploadPeriodOpen(input.clientId, periodMonth, input.periodYear);
      if (!open.ok) return { ok: false, error: open.error.message };
    }

    const batch = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const tacoNumber = taco ? await reserveTacoNumber(tx, firmId) : null;
      return tx.uploadBatch.create({
        data: {
          advisoryFirmId: firmId,
          clientId: input.clientId,
          routingCandidateIds: input.clientId ? [] : candidates,
          origin: "UPLOAD",
          createdById: userId,
          fileCount: input.fileCount,
          periodType: input.periodType,
          periodMonth,
          periodYear: input.periodYear,
          invoiceType: input.invoiceType,
          tacoNumber,
        },
        select: { id: true, tacoNumber: true, createdAt: true },
      });
    }, BATCH_TRANSACTION);
    return { ok: true, batch };
  } catch (err) {
    if (input.kind === "PER_INVOICE" && isTacoCreateConflict(err)) return { ok: false, error: TACO_CREATE_CONFLICT_ERROR };
    console.error("[tandas] no se ha podido crear la tanda:", err);
    return { ok: false, error: START_FAILED };
  }
}

export type UploadBatchCheck =
  | { ok: true; batch: { id: string; tacoNumber: number | null; createdAt: Date; clientId: string | null } }
  | { ok: false; status: 403 | 409 | 415; error: AppError };

/**
 * ¿Admite esta tanda el fichero en esa posición? (B-R4). Antes de subir nada
 * al almacenamiento. El acceso al cliente o a los candidatos ya lo ha mirado
 * la ruta; no hace falta haber creado la tanda: otro gestor con el cliente
 * puede completar un taco.
 */
export async function checkUploadBatchForFile(
  session: UploadSession,
  ref: { batchId: string; position: number },
  request: {
    clientId: string | null;
    candidateClientIds: string[];
    periodType: PeriodType;
    periodMonth: number;
    periodYear: number;
    type: string;
    fileKind: "pdf" | "image" | "xml";
  },
): Promise<UploadBatchCheck> {
  const { role, advisoryFirmId } = session.user;
  if ((role !== "ADMIN" && role !== "WORKER") || !advisoryFirmId) {
    return { ok: false, status: 403, error: appError("ERR-UPLOAD-008", `rol ${role} no sube en tandas`) };
  }
  const reject = (details: string): UploadBatchCheck =>
    ({ ok: false, status: 409, error: appError("ERR-UPLOAD-008", `tanda ${ref.batchId}: ${details}`) });

  const batch = await prisma.uploadBatch.findUnique({
    where: { id: ref.batchId },
    select: {
      id: true, advisoryFirmId: true, clientId: true, routingCandidateIds: true, origin: true, wholePdf: true,
      voidedAt: true, periodType: true, periodMonth: true, periodYear: true, invoiceType: true, tacoNumber: true,
      fileCount: true, createdAt: true,
    },
  });
  if (!batch || batch.advisoryFirmId !== advisoryFirmId) return reject("no existe en la asesoría");
  if (batch.origin !== "UPLOAD") return reject("es papel ubicado a mano");
  if (batch.wholePdf) return reject("es un taco entero");
  if (batch.voidedAt) return reject("anulada");
  if (request.clientId !== null) {
    if (batch.clientId !== request.clientId) return reject("de otro cliente");
  } else {
    const allowed = new Set(batch.routingCandidateIds);
    if (batch.clientId !== null || request.candidateClientIds.length === 0
      || !request.candidateClientIds.every((id) => allowed.has(id))) {
      return reject("candidatos que no son los de la tanda");
    }
  }
  if (batch.periodType !== request.periodType
    || batch.periodMonth !== storedPeriodMonth(request.periodType, request.periodMonth)
    || batch.periodYear !== request.periodYear) {
    return reject("de otro lote");
  }
  if (batch.invoiceType !== request.type) return reject("de otro tipo");
  if (batch.tacoNumber === null && batch.createdAt.getTime() < Date.now() - DIGITAL_BATCH_TTL_MS) return reject("caducada");
  if (!Number.isInteger(ref.position) || ref.position < 1 || ref.position > batch.fileCount) {
    return reject(`posición ${ref.position} fuera de 1..${batch.fileCount}`);
  }
  if (batch.tacoNumber !== null && request.fileKind === "xml") {
    return { ok: false, status: 415, error: appError("ERR-UPLOAD-010", `Taco ${batch.tacoNumber}`) };
  }
  return { ok: true, batch: { id: batch.id, tacoNumber: batch.tacoNumber, createdAt: batch.createdAt, clientId: batch.clientId } };
}

export type WholeTacoInput = {
  clientId: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  invoiceType: "PURCHASE" | "SALE" | "UNKNOWN";
  file: { name: string; buffer: Buffer; fileHash: string; mime: string };
};

export type WholeTacoResult =
  | { ok: true; batchId: string; tacoNumber: number; pageCount: number; alreadyUploaded: boolean }
  | { ok: false; status: 409 | 415 | 500; error: AppError }
  | { duplicate: true; of: string };

type TacoPdfTwin = Extract<WholeTacoResult, { ok: true } | { duplicate: true }>;

/**
 * El mismo PDF en un taco entero sin anular de la asesoría (B-R6): si es del
 * mismo cliente, lote y tipo y está sin dividir, es un reintento que sí llegó;
 * en otro, un duplicado. Un taco anulado no cuenta.
 */
async function findTacoPdfTwin(
  db: Prisma.TransactionClient,
  firmId: string,
  input: WholeTacoInput & { periodMonth: number },
): Promise<TacoPdfTwin | null> {
  const twins = await db.uploadBatch.findMany({
    where: { advisoryFirmId: firmId, wholePdf: true, voidedAt: null, pdfDocument: { fileHash: input.file.fileHash } },
    select: {
      id: true, clientId: true, periodType: true, periodMonth: true, periodYear: true, invoiceType: true,
      pdfSplitAt: true, tacoNumber: true, pdfPageCount: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const retry = twins.find((twin) =>
    twin.clientId === input.clientId && twin.periodType === input.periodType && twin.periodMonth === input.periodMonth
    && twin.periodYear === input.periodYear && twin.invoiceType === input.invoiceType && twin.pdfSplitAt === null);
  if (retry) {
    return { ok: true, batchId: retry.id, tacoNumber: retry.tacoNumber ?? 0, pageCount: retry.pdfPageCount ?? 0, alreadyUploaded: true };
  }
  const first = twins[0];
  return first ? { duplicate: true, of: `el PDF del Taco ${first.tacoNumber} (subido el ${formatDayEs(first.createdAt)})` } : null;
}

/** El gemelo apareció dentro de la transacción (dos subidas del mismo PDF a la vez). */
class TacoPdfTwinFound extends Error {
  constructor(readonly result: TacoPdfTwin) {
    super("el mismo PDF ya está en un taco entero");
  }
}

/**
 * Rama del taco entero de /api/uploads (B-R9), con el acceso y el periodo ya
 * comprobados. El PDF no es una factura: queda como Document del cliente
 * colgado de la tanda hasta que se marca dónde empieza cada factura. En una
 * transacción, el Document, el nº y la tanda; si algo falla no queda nada ni
 * se gasta ningún nº, y el fichero subido se borra.
 */
export async function createWholeTaco(session: UploadSession, input: WholeTacoInput): Promise<WholeTacoResult> {
  const { id: userId, advisoryFirmId: firmId } = session.user;
  if (!firmId) return { ok: false, status: 409, error: appError("ERR-UPLOAD-008", "sin asesoría") };
  const unreadable = (details: string): WholeTacoResult =>
    ({ ok: false, status: 415, error: appError("ERR-UPLOAD-011", `${input.file.name}: ${details}`) });
  if (input.file.mime !== "application/pdf") return unreadable(`no es un PDF (${input.file.mime})`);

  let pageCount: number;
  try {
    // Lanza también con un PDF cifrado (con contraseña).
    pageCount = (await PDFDocument.load(input.file.buffer, { updateMetadata: false })).getPageCount();
  } catch (err) {
    return unreadable(err instanceof Error ? err.message : "no se puede abrir");
  }
  if (pageCount < 1 || pageCount > TACO_PDF_MAX_PAGES) return unreadable(`${pageCount} páginas`);

  const target = { ...input, periodMonth: storedPeriodMonth(input.periodType, input.periodMonth) };
  const before = await findTacoPdfTwin(prisma, firmId, target);
  if (before) return before;

  const storageKey = uploadStorageKey(target, sanitizeFilenameForStorage(input.file.name));
  try {
    await putObject(storageKey, input.file.buffer, "application/pdf");
  } catch (e) {
    return { ok: false, status: 500, error: appError("ERR-UPLOAD-003", e instanceof Error ? e.message : "fallo al subir") };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const tacoNumber = await reserveTacoNumber(tx, firmId);
      // Con el bloqueo de la asesoría: un doble clic que llega a la vez ya ve el otro taco.
      const twin = await findTacoPdfTwin(tx, firmId, target);
      if (twin) throw new TacoPdfTwinFound(twin);
      const document = await tx.document.create({
        data: {
          filename: input.file.name,
          storageKey,
          fileType: "application/pdf",
          fileHash: input.file.fileHash,
          sizeBytes: input.file.buffer.length,
          uploadedBy: userId,
          clientId: input.clientId,
        },
        select: { id: true },
      });
      return tx.uploadBatch.create({
        data: {
          advisoryFirmId: firmId,
          clientId: input.clientId,
          origin: "UPLOAD",
          createdById: userId,
          fileCount: 1,
          periodType: input.periodType,
          periodMonth: target.periodMonth,
          periodYear: input.periodYear,
          invoiceType: input.invoiceType,
          tacoNumber,
          wholePdf: true,
          pdfDocumentId: document.id,
          pdfPageCount: pageCount,
        },
        select: { id: true, tacoNumber: true },
      });
    }, BATCH_TRANSACTION);
    return { ok: true, batchId: created.id, tacoNumber: created.tacoNumber ?? 0, pageCount, alreadyUploaded: false };
  } catch (err) {
    await deleteObject(storageKey);
    if (err instanceof TacoPdfTwinFound) return err.result;
    if (isTacoCreateConflict(err)) return { ok: false, status: 409, error: appError("ERR-UPLOAD-012") };
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[uploads] no se pudo registrar el taco entero ${storageKey}:`, error);
    await recordAutoTicket({
      kind: "server",
      name: error.name,
      message: error.message,
      path: "/api/uploads",
      routePath: "/api/uploads",
      routeType: "route",
      method: "POST",
      stack: error.stack ?? null,
      userId,
      firmId,
    });
    return { ok: false, status: 500, error: appError("ERR-SYS-001", "no se pudo registrar el taco entero") };
  }
}
