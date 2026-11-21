/**
 * Escrituras del archivo de una factura. Solo tocan InvoiceArchive: no cambian
 * Invoice.updatedAt, el testigo de guardar, validar, rechazar, dividir y
 * exportar (R1), así que no invalidan una revisión abierta.
 */
import { createHash } from "crypto";
import type { InvoiceStatus, OriginalMedium, OriginalMediumSource, Prisma, RetentionHoldReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs, AUDIT_TRANSACTION_OPTIONS } from "@/lib/auditLog";
import { ERROR_MESSAGES } from "@/lib/errorCodes";
import { isLockWaitError, isTransactionConflictError } from "@/lib/exportConflict";
import { validateOriginalAttachment } from "@/lib/fileValidation";
import { deleteObject, isStorageConfigured, putObject, sanitizeFilenameForStorage } from "@/lib/storage";
import { originalAttachmentKey } from "@/lib/uploadStorageKey";
import {
  canAutoUpdateMediumFamily,
  proposeOriginalMedium,
  type MediumProposal,
  type OriginalMediumReason,
  type PdfReading,
} from "@/lib/originalMedium";

/** Lo que ve quien edita el archivo si se cruza con otra escritura (un export,
 *  otra edición de la misma familia). */
export const ARCHIVE_EDIT_CONFLICT_ERROR = "Otra persona estaba cambiando estas facturas; vuelve a intentarlo.";

/**
 * { error } para una edición del archivo que Postgres ha abortado por
 * cruzarse con otra transacción o por esperarla demasiado; null si el error es
 * otro. Las acciones lo devuelven en vez de lanzar a la UI (anexo C11).
 */
export function archiveEditConflict(err: unknown): { error: string } | null {
  return isTransactionConflictError(err) || isLockWaitError(err) ? { error: ARCHIVE_EDIT_CONFLICT_ERROR } : null;
}

export type ArchiveAuditEntry = {
  invoiceId: string;
  userId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
};

/** Lo que hace falta para proponer electrónico o papel: el tipo de fichero de
 *  la factura y, en un PDF, lo que se ha leído de él. */
export type AutoMediumInput = {
  invoiceId: string;
  fileType: string;
  pdf?: PdfReading | null;
};

type FamilyRow = {
  invoiceId: string;
  originalMedium: OriginalMedium | null;
  originalMediumSource: OriginalMediumSource | null;
  originalMediumReason: string | null;
  originalDocumentId: string | null;
  tacoNumber: number | null;
};

export type AutoMediumWrite = {
  proposal: MediumProposal;
  /** Filas que ha escrito (la factura y, si llegó, sus partes), con lo que tenían antes. */
  written: FamilyRow[];
};

const AUTO_OR_EMPTY = [{ originalMediumSource: null }, { originalMediumSource: "AUTO" as const }];

/** Motivos de una fila sin propuesta que haya leído el fichero. */
const UNREAD_REASONS: readonly (string | null)[] = [null, "pdf_unreadable", "backfill_pending"];

/**
 * Escribe la propuesta automática de electrónico o papel (R10) de una factura
 * que no es parte de una división, solo si su medio está vacío o es AUTO
 * (R11: nunca pisa un taco ni lo que ha puesto una persona). Con
 * `pendingOnly`, solo si sigue AUTO y pendiente de detectar (la detección de
 * los PDF de antes del archivo). La propuesta llega a sus partes cuando toda
 * la familia está vacía o en AUTO (anexo C18), con motivo split. Una lectura
 * fallida o cortada no pisa una propuesta que sí leyó el PDF.
 *
 * Bloquea primero la fila de la raíz y luego el resto de la familia en orden
 * de factura (ver abajo). null si no ha escrito nada.
 */
export async function writeAutoMedium(
  tx: Prisma.TransactionClient,
  input: AutoMediumInput & { pendingOnly?: boolean },
): Promise<AutoMediumWrite | null> {
  const invoice = await tx.invoice.findUnique({ where: { id: input.invoiceId }, select: { splitFromId: true } });
  if (!invoice || invoice.splitFromId) return null;

  // La raíz primero: es el bloqueo que toma una división (planSplitArchive).
  // Si hay una a la vez, se espera aquí y la familia se lee después, ya con
  // sus partes nuevas; leída antes, se quedaban fuera, «Por confirmar» con el
  // resto de la familia en electrónico. El resto va por orden de factura y no
  // se cruza con el export, que nunca bloquea una raíz (SPLIT_SOURCE no se
  // exporta).
  await tx.$queryRaw`SELECT "invoiceId" FROM "InvoiceArchive" WHERE "invoiceId" = ${input.invoiceId} FOR UPDATE`;
  const family = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE fam AS (
      SELECT ${input.invoiceId}::text AS id
      UNION ALL
      SELECT i."id" FROM "Invoice" i JOIN fam ON i."splitFromId" = fam.id
    )
    SELECT id FROM fam`;
  const rows = await tx.$queryRaw<FamilyRow[]>`
    SELECT a."invoiceId",
           a."originalMedium"::text AS "originalMedium",
           a."originalMediumSource"::text AS "originalMediumSource",
           a."originalMediumReason",
           a."originalDocumentId",
           b."tacoNumber"
    FROM "InvoiceArchive" a
    LEFT JOIN "UploadBatch" b ON b."id" = a."uploadBatchId"
    WHERE a."invoiceId" = ANY(${family.map((f) => f.id)}::text[])
    ORDER BY a."invoiceId"
    FOR UPDATE OF a`;
  const root = rows.find((row) => row.invoiceId === input.invoiceId);
  if (!root) return null;

  const proposal = proposeOriginalMedium({
    fileType: input.fileType,
    hasOtherFormatOriginal: root.originalDocumentId != null,
    inTaco: root.tacoNumber != null,
    pdf: input.pdf,
  });
  // Un reproceso con la lectura cortada por tiempo (pdf.js comparte el hilo con
  // los demás análisis) o fallida no sabe nada nuevo: no borra un dato bueno.
  const readBefore = root.originalMediumSource === "AUTO" && !UNREAD_REASONS.includes(root.originalMediumReason);
  if (!input.pendingOnly && proposal.reason === "pdf_unreadable" && readBefore) return null;

  const medium = { originalMedium: proposal.medium, originalMediumSource: proposal.source, pdfProducer: proposal.pdfProducer };
  const pendingReason: OriginalMediumReason = "backfill_pending";
  const rootWrite = await tx.invoiceArchive.updateMany({
    where: {
      invoiceId: root.invoiceId,
      invoice: { splitFromId: null },
      ...(input.pendingOnly
        ? { originalMediumSource: "AUTO", originalMediumReason: pendingReason }
        : { OR: AUTO_OR_EMPTY }),
    },
    data: { ...medium, originalMediumReason: proposal.reason },
  });
  if (rootWrite.count === 0) return null;

  const written = [root];
  const parts = rows.filter((row) => row !== root);
  if (parts.length > 0 && canAutoUpdateMediumFamily(rows)) {
    const splitReason: OriginalMediumReason = "split";
    await tx.invoiceArchive.updateMany({
      where: { invoiceId: { in: parts.map((part) => part.invoiceId) }, OR: AUTO_OR_EMPTY },
      data: { ...medium, originalMediumReason: splitReason },
    });
    written.push(...parts);
  }
  return { proposal, written };
}

/**
 * Electrónico o papel al analizar una factura: la propuesta (R10) con la fila
 * de archivo leída dentro de la transacción vallada del análisis, así que una
 * ejecución que ya no es la dueña no escribe. Devuelve las entradas de
 * auditoría para que el análisis las escriba con las suyas: auto:originalMedium
 * solo si un reproceso le da la vuelta a un medio que ya había propuesto la
 * app, no en la primera propuesta (ni en la que sustituye a «Pendiente de
 * detectar»).
 */
export async function applyAutoMedium(
  tx: Prisma.TransactionClient,
  input: AutoMediumInput & { userId: string },
): Promise<ArchiveAuditEntry[]> {
  const result = await writeAutoMedium(tx, input);
  if (!result) return [];
  const pendingReason: OriginalMediumReason = "backfill_pending";
  return result.written
    .filter((row) =>
      row.originalMediumSource === "AUTO"
      && row.originalMediumReason !== pendingReason
      && row.originalMedium !== result.proposal.medium)
    .map((row) => ({
      invoiceId: row.invoiceId,
      userId: input.userId,
      field: "auto:originalMedium",
      oldValue: row.originalMedium,
      newValue: result.proposal.medium,
    }));
}

// ── Ediciones a mano: electrónico o papel y «conservar más» ─────────────────

/** Tope de facturas de una edición en bloque (la selección de una página). */
export const ARCHIVE_EDIT_MAX_INVOICES = 200;

/** Si una edición se cruza con un export grande, mejor avisar pronto que
 *  esperar los 15 s del statement_timeout. El test lo acorta. */
export const ARCHIVE_EDIT_WAITS = { lockTimeoutMs: 5_000 };

export type ArchiveEditResult = { error: string } | { ok: true; clientId: string; changed: number };

const NOT_FOUND = "No se han encontrado esas facturas. Recarga la página.";
const MIXED_CLIENTS = "Las facturas tienen que ser del mismo cliente.";
const STILL_ANALYZING =
  "Alguna factura se está analizando: espera a que termine para cambiar si el original es electrónico o papel.";
const HOLD_REASON_REQUIRED = "Elige por qué hay que conservarlas más.";

/** Mientras se analiza, el análisis puede escribir el medio (R11). */
const ANALYSIS_STATUSES: readonly string[] = ["UPLOADED", "ANALYZING"] satisfies InvoiceStatus[];

/** Las facturas de la asesoría, todas de un mismo cliente: una edición en
 *  bloque sale siempre de la pestaña Archivo de un cliente. */
async function invoicesOfOneClient(
  firmId: string,
  invoiceIds: readonly string[],
): Promise<{ ids: string[]; clientId: string } | { error: string }> {
  const ids = [...new Set(invoiceIds)];
  if (ids.length === 0) return { error: NOT_FOUND };
  const rows = await prisma.invoice.findMany({
    where: { id: { in: ids }, client: { advisoryFirmId: firmId } },
    select: { clientId: true },
  });
  if (rows.length !== ids.length) return { error: NOT_FOUND };
  if (new Set(rows.map((row) => row.clientId)).size > 1) return { error: MIXED_CLIENTS };
  return { ids, clientId: rows[0].clientId };
}

/** Una transacción de edición: un conflicto o una espera larga es { error }
 *  (anexo C11); cualquier otro fallo sigue hacia la acción. */
async function archiveEditTransaction(
  work: (tx: Prisma.TransactionClient) => Promise<ArchiveEditResult>,
): Promise<ArchiveEditResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // SET LOCAL lock_timeout; set_config admite el valor como parámetro.
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${ARCHIVE_EDIT_WAITS.lockTimeoutMs}ms`}, true)`;
      return work(tx);
    }, AUDIT_TRANSACTION_OPTIONS);
  } catch (err) {
    const conflict = archiveEditConflict(err);
    if (conflict) return conflict;
    throw err;
  }
}

type ManualMediumRow = {
  invoiceId: string;
  originalMedium: OriginalMedium | null;
  originalMediumSource: OriginalMediumSource | null;
  status: string;
};

/**
 * Electrónico, papel o «Por confirmar» (medium null), puesto por una persona
 * (R11, anexo C2): origen MANUAL y motivo manual, que el análisis ya no pisa.
 * Cambia toda la familia de cada división (la raíz y sus partes): es el mismo
 * papel. No se puede mientras alguna se analiza. Audita originalMedium en cada
 * factura que cambia, también al confirmar a mano lo que había propuesto la
 * app. Solo escribe en InvoiceArchive: Invoice.updatedAt no cambia.
 *
 * Bloquea como la división y la propuesta automática: primero las raíces y
 * después el resto de las familias, en orden de factura.
 */
export async function setOriginalMedium(input: {
  firmId: string;
  invoiceIds: readonly string[];
  medium: OriginalMedium | null;
  userId: string;
}): Promise<ArchiveEditResult> {
  const found = await invoicesOfOneClient(input.firmId, input.invoiceIds);
  if ("error" in found) return found;

  // Las raíces se buscan fuera: splitFromId no cambia nunca.
  const roots = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up AS (
      SELECT i."id", i."splitFromId" FROM "Invoice" i WHERE i."id" = ANY(${found.ids}::text[])
      UNION
      SELECT p."id", p."splitFromId" FROM "Invoice" p JOIN up ON p."id" = up."splitFromId"
    )
    SELECT "id" FROM up WHERE "splitFromId" IS NULL`;
  const rootIds = roots.map((root) => root.id);

  return archiveEditTransaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "invoiceId" FROM "InvoiceArchive" WHERE "invoiceId" = ANY(${rootIds}::text[]) ORDER BY "invoiceId" FOR UPDATE`;
    // Leída después de bloquear las raíces: si se estaba dividiendo, ya con
    // las partes nuevas.
    const rows = await tx.$queryRaw<ManualMediumRow[]>`
      WITH RECURSIVE fam AS (
        SELECT unnest(${rootIds}::text[]) AS id
        UNION
        SELECT i."id" FROM "Invoice" i JOIN fam ON i."splitFromId" = fam.id
      )
      SELECT a."invoiceId",
             a."originalMedium"::text AS "originalMedium",
             a."originalMediumSource"::text AS "originalMediumSource",
             i."status"::text AS "status"
      FROM "InvoiceArchive" a
      JOIN "Invoice" i ON i."id" = a."invoiceId"
      JOIN "Client" c ON c."id" = i."clientId"
      WHERE a."invoiceId" IN (SELECT id FROM fam) AND c."advisoryFirmId" = ${input.firmId}
      ORDER BY a."invoiceId"
      FOR UPDATE OF a`;
    if (rows.length === 0) return { error: NOT_FOUND };
    if (rows.some((row) => ANALYSIS_STATUSES.includes(row.status))) return { error: STILL_ANALYZING };

    const changed = rows.filter((row) => row.originalMediumSource !== "MANUAL" || row.originalMedium !== input.medium);
    if (changed.length > 0) {
      const manualReason: OriginalMediumReason = "manual";
      await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: changed.map((row) => row.invoiceId) } },
        data: { originalMedium: input.medium, originalMediumSource: "MANUAL", originalMediumReason: manualReason },
      });
      await appendAuditLogs(
        changed.map((row) => ({
          invoiceId: row.invoiceId,
          userId: input.userId,
          field: "originalMedium",
          oldValue: row.originalMedium,
          newValue: input.medium,
        })),
        tx,
      );
    }
    return { ok: true, clientId: found.clientId, changed: changed.length };
  });
}

/** Valor de la auditoría retentionHold: el motivo, o «false» sin «conservar más». */
function retentionHoldAuditValue(hold: boolean, reason: RetentionHoldReason | null): string {
  return hold ? (reason ?? "OTHER") : "false";
}

type RetentionRow = {
  invoiceId: string;
  retentionHold: boolean;
  retentionHoldReason: RetentionHoldReason | null;
  retentionHoldNote: string | null;
};

/**
 * «Conservar más» (R12) de una factura o de varias del mismo cliente: con
 * motivo y nota, o quitado. Audita retentionHold en cada factura en la que
 * cambia la marca o el motivo; la nota sola no deja entrada. Solo escribe en
 * InvoiceArchive: vale con el periodo cerrado y con la factura exportada.
 */
export async function setRetentionHold(input: {
  firmId: string;
  invoiceIds: readonly string[];
  hold: boolean;
  reason: RetentionHoldReason | null;
  note: string | null;
  userId: string;
}): Promise<ArchiveEditResult> {
  if (input.hold && !input.reason) return { error: HOLD_REASON_REQUIRED };
  const found = await invoicesOfOneClient(input.firmId, input.invoiceIds);
  if ("error" in found) return found;
  const reason = input.hold ? input.reason : null;
  const note = input.hold ? input.note?.trim() || null : null;

  return archiveEditTransaction(async (tx) => {
    const rows = await tx.$queryRaw<RetentionRow[]>`
      SELECT "invoiceId", "retentionHold", "retentionHoldReason"::text AS "retentionHoldReason", "retentionHoldNote"
      FROM "InvoiceArchive"
      WHERE "invoiceId" = ANY(${found.ids}::text[])
      ORDER BY "invoiceId"
      FOR UPDATE`;
    if (rows.length !== found.ids.length) return { error: NOT_FOUND };

    const changed = rows.filter((row) =>
      row.retentionHold !== input.hold || row.retentionHoldReason !== reason || row.retentionHoldNote !== note);
    if (changed.length > 0) {
      await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: changed.map((row) => row.invoiceId) } },
        data: { retentionHold: input.hold, retentionHoldReason: reason, retentionHoldNote: note },
      });
      const newValue = retentionHoldAuditValue(input.hold, reason);
      await appendAuditLogs(
        changed
          .map((row) => ({ row, oldValue: retentionHoldAuditValue(row.retentionHold, row.retentionHoldReason) }))
          .filter(({ oldValue }) => oldValue !== newValue)
          .map(({ row, oldValue }) => ({ invoiceId: row.invoiceId, userId: input.userId, field: "retentionHold", oldValue, newValue })),
        tx,
      );
    }
    return { ok: true, clientId: found.clientId, changed: changed.length };
  });
}

// ── Original en otro formato (Word, Excel…): adjuntarlo y quitarlo ───────────

const NO_ATTACHMENT = "No tiene ningún original adjunto. Recarga la página.";
const STILL_ANALYZING_ATTACHMENT = "Se está analizando: espera a que termine para adjuntar el original.";

/** Tope de niveles al subir por una división: en la práctica son uno o dos. */
const MAX_SPLIT_DEPTH = 100;

type AttachmentFamilyRow = {
  invoiceId: string;
  status: string;
  originalMedium: OriginalMedium | null;
  originalMediumSource: OriginalMediumSource | null;
  originalMediumReason: string | null;
  originalDocumentId: string | null;
  documentFilename: string | null;
};

/** La factura y la raíz de su división (ella misma si no es una parte),
 *  dentro de la asesoría. splitFromId no cambia nunca: se busca fuera de la
 *  transacción. */
async function invoiceAndSplitRoot(
  firmId: string,
  invoiceId: string,
): Promise<{ clientId: string; rootId: string; rootClientId: string } | null> {
  const chain = await prisma.$queryRaw<{ id: string; clientId: string; depth: number; isRoot: boolean }[]>`
    WITH RECURSIVE up AS (
      SELECT i."id", i."splitFromId", i."clientId", 0 AS depth FROM "Invoice" i WHERE i."id" = ${invoiceId}
      UNION ALL
      SELECT p."id", p."splitFromId", p."clientId", up.depth + 1
      FROM "Invoice" p JOIN up ON p."id" = up."splitFromId"
      WHERE up.depth < ${MAX_SPLIT_DEPTH}
    )
    SELECT up."id", up."clientId", up.depth, (up."splitFromId" IS NULL) AS "isRoot"
    FROM up JOIN "Client" c ON c."id" = up."clientId"
    WHERE c."advisoryFirmId" = ${firmId}`;
  const start = chain.find((row) => row.depth === 0);
  const root = chain.find((row) => row.isRoot);
  return start && root ? { clientId: start.clientId, rootId: root.id, rootClientId: root.clientId } : null;
}

/** Bloquea la fila de la raíz y después la de toda su familia, en orden de
 *  factura (la convención de la división y de las demás ediciones), y la lee. */
async function lockAttachmentFamily(
  tx: Prisma.TransactionClient,
  firmId: string,
  rootId: string,
): Promise<AttachmentFamilyRow[]> {
  await tx.$queryRaw`SELECT "invoiceId" FROM "InvoiceArchive" WHERE "invoiceId" = ${rootId} FOR UPDATE`;
  return tx.$queryRaw<AttachmentFamilyRow[]>`
    WITH RECURSIVE fam AS (
      SELECT ${rootId}::text AS id
      UNION
      SELECT i."id" FROM "Invoice" i JOIN fam ON i."splitFromId" = fam.id
    )
    SELECT a."invoiceId",
           i."status"::text AS "status",
           a."originalMedium"::text AS "originalMedium",
           a."originalMediumSource"::text AS "originalMediumSource",
           a."originalMediumReason",
           a."originalDocumentId",
           d."filename" AS "documentFilename"
    FROM "InvoiceArchive" a
    JOIN "Invoice" i ON i."id" = a."invoiceId"
    JOIN "Client" c ON c."id" = i."clientId"
    LEFT JOIN "Document" d ON d."id" = a."originalDocumentId"
    WHERE a."invoiceId" IN (SELECT id FROM fam) AND c."advisoryFirmId" = ${firmId}
    ORDER BY a."invoiceId"
    FOR UPDATE OF a`;
}

/**
 * Auditoría originalDocument de cambiar el adjunto de `target` (de su nombre
 * de antes al nuevo, o a vacío). Si es la raíz de una división, también en
 * cada parte sin adjunto propio: su original es el de la raíz.
 */
function originalDocumentAudit(
  rows: readonly AttachmentFamilyRow[],
  target: AttachmentFamilyRow,
  rootId: string,
  newValue: string | null,
  userId: string,
): ArchiveAuditEntry[] {
  const affected = target.invoiceId === rootId
    ? rows.filter((row) => row === target || row.originalDocumentId == null)
    : [target];
  return affected.map((row) => ({
    invoiceId: row.invoiceId,
    userId,
    field: "originalDocument",
    oldValue: target.documentFilename,
    newValue,
  }));
}

/**
 * Adjunta el original en otro formato (Word, Excel, OpenDocument o RTF, R19)
 * de una factura cuya copia en PDF ya está subida. El fichero se valida por su
 * contenido, se guarda con una clave nueva (anexo C19) y se crea un Document
 * del cliente; la fila de archivo apunta a él y el medio pasa a electrónico
 * (MANUAL, motivo other_format). En una división va a la raíz, con el medio de
 * toda la familia: es el original de todo el documento. Un adjunto anterior se
 * queda en el almacenamiento y en la auditoría. Solo escribe en el archivo y
 * en Document: Invoice.updatedAt no cambia.
 */
export async function attachOriginalDocument(input: {
  firmId: string;
  invoiceId: string;
  userId: string;
  file: { name: string; bytes: Uint8Array };
}): Promise<ArchiveEditResult> {
  const filename = input.file.name.trim();
  const valid = validateOriginalAttachment(input.file.bytes, filename);
  if (!valid.ok) return { error: `${ERROR_MESSAGES["ERR-ARCHIVE-001"]} ${valid.reason}` };
  const found = await invoiceAndSplitRoot(input.firmId, input.invoiceId);
  if (!found) return { error: NOT_FOUND };
  if (!isStorageConfigured()) return { error: "El almacenamiento no está configurado. Avisa al administrador." };

  const storageKey = originalAttachmentKey(found.rootClientId, sanitizeFilenameForStorage(filename));
  try {
    await putObject(storageKey, input.file.bytes, valid.mime);
  } catch (err) {
    console.error(`[archivo] ${input.invoiceId}: no se pudo subir el original adjunto:`, err);
    return { error: ERROR_MESSAGES["ERR-UPLOAD-003"] };
  }
  const fileHash = createHash("sha256").update(input.file.bytes).digest("hex");

  let result: ArchiveEditResult;
  try {
    result = await archiveEditTransaction(async (tx) => {
      const rows = await lockAttachmentFamily(tx, input.firmId, found.rootId);
      const root = rows.find((row) => row.invoiceId === found.rootId);
      if (!root) return { error: NOT_FOUND };
      if (rows.some((row) => ANALYSIS_STATUSES.includes(row.status))) return { error: STILL_ANALYZING_ATTACHMENT };

      const document = await tx.document.create({
        data: {
          filename,
          storageKey,
          fileType: valid.mime,
          fileHash,
          sizeBytes: input.file.bytes.length,
          uploadedBy: input.userId,
          clientId: found.rootClientId,
        },
      });
      await tx.invoiceArchive.update({ where: { invoiceId: root.invoiceId }, data: { originalDocumentId: document.id } });
      const reason: OriginalMediumReason = "other_format";
      await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: rows.map((row) => row.invoiceId) } },
        data: { originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: reason },
      });
      await appendAuditLogs(
        [
          ...originalDocumentAudit(rows, root, found.rootId, filename, input.userId),
          ...rows
            .filter((row) => row.originalMediumSource !== "MANUAL" || row.originalMedium !== "ELECTRONIC")
            .map((row) => ({
              invoiceId: row.invoiceId,
              userId: input.userId,
              field: "originalMedium",
              oldValue: row.originalMedium,
              newValue: "ELECTRONIC",
            })),
        ],
        tx,
      );
      return { ok: true, clientId: found.clientId, changed: rows.length };
    });
  } catch (err) {
    // La clave es nueva: el objeto no lo usa nadie más.
    await deleteObject(storageKey);
    throw err;
  }
  if ("error" in result) await deleteObject(storageKey);
  return result;
}

/**
 * «Quitar el original adjunto» (anexo C7), por si se adjuntó a la factura
 * equivocada: la fila deja de apuntar al Document, con la auditoría
 * originalDocument «nombre.doc → —». No borra ni el Document ni el objeto, y
 * el medio no cambia (el motivo deja de decir que hay un adjunto). En una
 * parte cuyo adjunto es el de su raíz, actúa sobre la raíz.
 */
export async function removeOriginalDocument(input: {
  firmId: string;
  invoiceId: string;
  userId: string;
}): Promise<ArchiveEditResult> {
  const found = await invoiceAndSplitRoot(input.firmId, input.invoiceId);
  if (!found) return { error: NOT_FOUND };
  return archiveEditTransaction(async (tx) => {
    const rows = await lockAttachmentFamily(tx, input.firmId, found.rootId);
    const own = rows.find((row) => row.invoiceId === input.invoiceId);
    const target = own?.originalDocumentId ? own : rows.find((row) => row.invoiceId === found.rootId);
    if (!target?.originalDocumentId) return { error: NO_ATTACHMENT };

    const entries = originalDocumentAudit(rows, target, found.rootId, null, input.userId);
    await tx.invoiceArchive.update({ where: { invoiceId: target.invoiceId }, data: { originalDocumentId: null } });
    // «Hay un original en otro formato adjunto» ya no es verdad: el medio lo
    // sigue habiendo puesto una persona.
    const otherFormat: OriginalMediumReason = "other_format";
    const manual: OriginalMediumReason = "manual";
    await tx.invoiceArchive.updateMany({
      where: { invoiceId: { in: entries.map((entry) => entry.invoiceId) }, originalMediumReason: otherFormat },
      data: { originalMediumReason: manual },
    });
    await appendAuditLogs(entries, tx);
    return { ok: true, clientId: found.clientId, changed: entries.length };
  });
}
