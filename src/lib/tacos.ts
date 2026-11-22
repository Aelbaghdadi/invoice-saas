/**
 * Escrituras de los tacos (entrega B): guardar un taco en una caja o
 * devolverlo (B-R10), «Era papel: crear taco» (B-R15), «Poner ubicación» y
 * «Sacar del taco» (B-R14, B-R16), anular (B-R22) y completar (B-R23) un
 * taco, y la caja que se propone (B-R11).
 *
 * Todas van en una transacción de edición del archivo (lock_timeout corto y
 * conflicto → «Otra persona…») y bloquean en el mismo orden (B-R21): la
 * tanda, las filas de las raíces de división, el resto de filas por orden de
 * factura, después se vuelve a leer y se valida con todo bloqueado, después
 * el bloqueo de la asesoría (si hay que reservar un nº de taco o calcular
 * «Caja nueva») y la auditoría al final. Solo escriben en InvoiceArchive y
 * UploadBatch: Invoice.updatedAt (el testigo de la revisión) no cambia.
 */
import { Prisma, type OriginalMedium, type PaperBoxMode, type UploadBatchOrigin } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs } from "@/lib/auditLog";
import { uploadBatchVisibleWhere, type TacoViewer } from "@/lib/archiveAccess";
import { ARCHIVE_EDIT_CONFLICT_ERROR, ARCHIVE_EDIT_MAX_INVOICES, archiveEditTransaction, type ArchiveAuditEntry } from "@/lib/archiveEdits";
import { fiscalYearLabel, fiscalYearOf, fiscalYearRange } from "@/lib/archiveRules";
import { boxLabelKey, normalizeBoxLabel, proposeBoxLabels, type BoxUse } from "@/lib/boxProposal";
import { formatDayEs } from "@/lib/dates";
import { paperLocationOf, tacoLabel, type PaperLocation, type TacoRef } from "@/lib/paperLocation";
import { IN_ANALYSIS } from "@/lib/invoiceStatuses";
import { invoicePeriod } from "@/lib/period";
import { assertUploadPeriodOpen } from "@/lib/uploadAccess";
import { reserveTacoNumber, TACO_LOCK_NAMESPACE, UPLOAD_BATCH_MAX_FILES } from "@/lib/uploadBatches";
import type { OriginalMediumReason } from "@/lib/originalMedium";

export type BoxDestination = { kind: "box"; label: string } | { kind: "newBox" } | { kind: "returned" };
export type PlaceDestination = BoxDestination | { kind: "client" };
export type PlaceTarget =
  | { invoiceIds: string[] }
  | { clientId: string; fiscalYear: number; includeUnconfirmed: boolean }
  | { moveInvoiceId: string };
export type PlaceCount = {
  placeable: number;
  unconfirmed: number;
  paper: number;
  /** analyzing: «Por confirmar» que aún se analiza (o de una división con alguna así). */
  skipped: { electronic: number; inTaco: number; rejected: number; analyzing: number };
};
export type TacoEditResult<T = object> = ({ ok: true } & T) | { error: string };
export type FiledTaco = { tacoNumber: number; locationText: string; boxLabel: string | null };
export type ConvertedTaco = { tacoNumber: number; converted: number };
export type PlacedPaper = PlaceCount & { tacoNumber: number | null; locationText: string };
export type VoidedTaco = { tacoNumber: number };
export type ExtendedTaco = { fileCount: number; firstNewPosition: number };
export type BoxProposal = {
  mode: PaperBoxMode;
  proposed: string;
  next: string;
  lastUsed: string | null;
  suggestions: string[];
  /** Para la línea de ayuda: «Es la última caja que usasteis para {cliente} en {ejercicio}.» */
  clientName: string | null;
  fiscalYearLabel: string;
};

/** = ARCHIVE_EDIT_MAX_INVOICES: la selección de una página. */
export const PLACE_PAPER_MAX_SELECTED = ARCHIVE_EDIT_MAX_INVOICES;
export const PLACE_PAPER_MAX_SCOPE = 2000;
export const VOID_REASON_MIN = 2;
export const VOID_REASON_MAX = 200;

export const TACO_NOT_FOUND = "No se ha encontrado el taco. Recarga la página.";
export const TACO_VOIDED = "Este taco está anulado.";
export const BATCH_NOT_FOUND = "No se ha encontrado la subida. Recarga la página.";
export const ARCHIVE_NOT_CONVERTED = "El papel ubicado a mano no se convierte en taco.";
export const INVOICES_NOT_FOUND = "No se han encontrado esas facturas. Recarga la página.";
export const MIXED_CLIENTS = "Las facturas tienen que ser del mismo cliente.";
export const NOTHING_WITHOUT_LOCATION = "No hay nada sin ubicación en este ejercicio.";
export const TOO_MANY_SELECTED = `Como mucho ${PLACE_PAPER_MAX_SELECTED} facturas a la vez.`;
export const TOO_MANY_IN_SCOPE = "Como mucho 2.000 facturas a la vez.";
export const NOT_IN_A_TACO = "Esta factura no tiene papel en un taco.";
export const VOID_REASON_ERROR = "Escribe por qué lo anulas (entre 2 y 200 caracteres).";
export const VOID_ALIVE_INVOICES = "Este taco tiene facturas sin rechazar: recházalas antes o divídelo.";
export const VOID_PAPER_FROM_OUTSIDE = "Hay papel de otras facturas guardado en este taco: no se puede anular.";
export const VOID_ALREADY = "Este taco ya está anulado.";
export const VOID_ARCHIVE = "El papel ubicado a mano no se anula.";
export const EXTEND_CONFLICT = "Otra persona estaba completando este taco; recarga la página.";
export const EXTEND_TOO_MANY = `Como mucho ${UPLOAD_BATCH_MAX_FILES} páginas por taco.`;
export const EXTEND_WHOLE_PDF = "El taco entero no se completa así: sus facturas salen al marcar dónde empieza cada una.";
export const EXTEND_NOT_A_TACO = "Solo se completa un taco de factura a factura.";

export function alreadyTacoError(tacoNumber: number): string {
  return `Esta tanda ya es el ${tacoLabel(tacoNumber)}.`;
}

// ── Lo común ────────────────────────────────────────────────────────────────

/** Lo que se lee de una tanda al bloquearla. */
type LockedBatch = {
  id: string;
  clientId: string | null;
  origin: UploadBatchOrigin;
  tacoNumber: number | null;
  wholePdf: boolean;
  fileCount: number;
  boxLabel: string | null;
  returnedAt: Date | null;
  filedAt: Date | null;
  voidedAt: Date | null;
};

async function lockBatch(tx: Prisma.TransactionClient, firmId: string, batchId: string): Promise<LockedBatch | null> {
  const [batch] = await tx.$queryRaw<LockedBatch[]>`
    SELECT "id", "clientId", "origin"::text AS "origin", "tacoNumber", "wholePdf", "fileCount",
           "boxLabel", "returnedAt", "filedAt", "voidedAt"
    FROM "UploadBatch"
    WHERE "id" = ${batchId} AND "advisoryFirmId" = ${firmId}
    FOR UPDATE`;
  return batch ?? null;
}

/** El estado de una fila de archivo que decide su ubicación. */
type ArchiveStateRow = {
  invoiceId: string;
  clientId: string;
  status: string;
  splitFromId: string | null;
  originalMedium: OriginalMedium | null;
  paperHeldByClient: boolean;
  paperBatchId: string | null;
  uploadBatchId: string | null;
  uploadPosition: number | null;
  periodMonth: number;
  periodYear: number;
  accountingPeriodMonth: number | null;
  accountingPeriodYear: number | null;
};

const ARCHIVE_STATE_COLUMNS = Prisma.sql`
  a."invoiceId", i."clientId", i."status"::text AS "status", i."splitFromId",
  a."originalMedium"::text AS "originalMedium", a."paperHeldByClient", a."paperBatchId",
  a."uploadBatchId", a."uploadPosition",
  i."periodMonth", i."periodYear", i."accountingPeriodMonth", i."accountingPeriodYear"`;

/**
 * Bloquea (en el orden de B-R21: primero las raíces de división y después
 * todas, por factura) y lee las filas de archivo que cumplen `where` (sobre
 * «a», InvoiceArchive), dentro de la asesoría.
 */
async function lockArchiveRows(
  tx: Prisma.TransactionClient,
  firmId: string,
  where: Prisma.Sql,
): Promise<ArchiveStateRow[]> {
  await tx.$queryRaw`
    SELECT a."invoiceId"
    FROM "InvoiceArchive" a
    JOIN "Invoice" i ON i."id" = a."invoiceId"
    JOIN "Client" c ON c."id" = i."clientId"
    WHERE (${where}) AND i."splitFromId" IS NULL AND c."advisoryFirmId" = ${firmId}
    ORDER BY a."invoiceId"
    FOR UPDATE OF a`;
  return tx.$queryRaw<ArchiveStateRow[]>`
    SELECT ${ARCHIVE_STATE_COLUMNS}
    FROM "InvoiceArchive" a
    JOIN "Invoice" i ON i."id" = a."invoiceId"
    JOIN "Client" c ON c."id" = i."clientId"
    WHERE (${where}) AND c."advisoryFirmId" = ${firmId}
    ORDER BY a."invoiceId"
    FOR UPDATE OF a`;
}

const TACO_REF_SELECT = {
  id: true,
  tacoNumber: true,
  origin: true,
  wholePdf: true,
  boxLabel: true,
  returnedAt: true,
  filedAt: true,
  voidedAt: true,
} satisfies Prisma.UploadBatchSelect;

/** Las tandas de llegada y los tacos del papel de esas filas. */
async function loadTacoRefs(
  db: Prisma.TransactionClient,
  firmId: string,
  rows: readonly ArchiveStateRow[],
): Promise<Map<string, TacoRef>> {
  const ids = [...new Set(rows.flatMap((row) => [row.uploadBatchId, row.paperBatchId]).filter((id): id is string => id != null))];
  if (ids.length === 0) return new Map();
  const batches = await db.uploadBatch.findMany({ where: { id: { in: ids }, advisoryFirmId: firmId }, select: TACO_REF_SELECT });
  return new Map(batches.map((batch) => [batch.id, batch]));
}

function tacoRefOf(batch: LockedBatch): TacoRef {
  return {
    id: batch.id,
    tacoNumber: batch.tacoNumber,
    origin: batch.origin,
    wholePdf: batch.wholePdf,
    boxLabel: batch.boxLabel,
    returnedAt: batch.returnedAt,
    filedAt: batch.filedAt,
    voidedAt: batch.voidedAt,
  };
}

function locationOf(row: ArchiveStateRow, refs: ReadonlyMap<string, TacoRef>): PaperLocation {
  return paperLocationOf({
    medium: row.originalMedium,
    paperHeldByClient: row.paperHeldByClient,
    uploadPosition: row.uploadPosition,
    arrival: row.uploadBatchId ? refs.get(row.uploadBatchId) ?? null : null,
    paper: row.paperBatchId ? refs.get(row.paperBatchId) ?? null : null,
  });
}

/** Auditoría paperLocation de las filas cuyo texto cambia (B-R13, B-R14…). */
function paperLocationAudits(
  changes: readonly { row: ArchiveStateRow; before: string; after: string }[],
  userId: string,
): ArchiveAuditEntry[] {
  return changes
    .filter((change) => change.before !== change.after)
    .map((change) => ({
      invoiceId: change.row.invoiceId,
      userId,
      field: "paperLocation",
      oldValue: change.before,
      newValue: change.after,
    }));
}

/** El bloqueo de la asesoría de B-R3, sin reservar nº: «Caja nueva» (B-R10). */
async function lockFirmTacos(tx: Prisma.TransactionClient, firmId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}::int, hashtext(${firmId}::text))`;
}

/** Una escritura que no ha cambiado las filas que esperaba: otra la ha adelantado. */
class TacoEditConflict extends Error {
  constructor() {
    super("las filas han cambiado entre la lectura y la escritura");
  }
}

/** Corre la edición; un TacoEditConflict es el conflicto de siempre. */
async function runTacoEdit<T extends object>(
  work: (tx: Prisma.TransactionClient) => Promise<TacoEditResult<T>>,
): Promise<TacoEditResult<T>> {
  try {
    return await archiveEditTransaction(work);
  } catch (err) {
    if (err instanceof TacoEditConflict) return { error: ARCHIVE_EDIT_CONFLICT_ERROR };
    throw err;
  }
}

function returnedText(at: Date): string {
  return `Devuelto al cliente el ${formatDayEs(at)}`;
}

const PAPER_TACO_REASON: OriginalMediumReason = "taco";
const MANUAL_REASON: OriginalMediumReason = "manual";

// ── Caja que se propone (B-R11) ─────────────────────────────────────────────

type BoxScope = {
  mode: PaperBoxMode;
  /** null: taco de varios clientes (año natural). */
  clientId: string | null;
  clientName: string | null;
  startMonth: number;
  /** Año en que empieza el ejercicio (o el año natural sin cliente). */
  fiscalStartYear: number;
  fiscalYearLabel: string;
};

/** Ejercicio de un taco: el del lote con el inicio del cliente; en ARCHIVE, el que se guardó. */
export function tacoFiscalStartYear(
  taco: { origin: UploadBatchOrigin; periodMonth: number | null; periodYear: number },
  startMonth: number,
): number {
  if (taco.origin === "ARCHIVE" || taco.periodMonth == null) return taco.periodYear;
  return fiscalYearOf(taco.periodYear, taco.periodMonth, startMonth).startYear;
}

async function boxScopeOfTaco(db: Prisma.TransactionClient, firmId: string, batchId: string): Promise<BoxScope | null> {
  const batch = await db.uploadBatch.findFirst({
    where: { id: batchId, advisoryFirmId: firmId, tacoNumber: { not: null } },
    select: {
      origin: true,
      periodMonth: true,
      periodYear: true,
      client: { select: { id: true, name: true, fiscalYearStartMonth: true } },
      advisoryFirm: { select: { paperBoxMode: true } },
    },
  });
  if (!batch) return null;
  const mode = batch.advisoryFirm.paperBoxMode;
  if (!batch.client) {
    return { mode, clientId: null, clientName: null, startMonth: 1, fiscalStartYear: batch.periodYear, fiscalYearLabel: String(batch.periodYear) };
  }
  const startMonth = batch.client.fiscalYearStartMonth;
  const fiscalStartYear = tacoFiscalStartYear(batch, startMonth);
  return {
    mode,
    clientId: batch.client.id,
    clientName: batch.client.name,
    startMonth,
    fiscalStartYear,
    fiscalYearLabel: fiscalYearLabel(fiscalStartYear, startMonth),
  };
}

async function boxScopeOfClientYear(
  db: Prisma.TransactionClient,
  firmId: string,
  clientId: string,
  fiscalYear: number,
): Promise<BoxScope | null> {
  const client = await db.client.findFirst({
    where: { id: clientId, advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true, fiscalYearStartMonth: true, advisoryFirm: { select: { paperBoxMode: true } } },
  });
  if (!client) return null;
  return {
    mode: client.advisoryFirm.paperBoxMode,
    clientId: client.id,
    clientName: client.name,
    startMonth: client.fiscalYearStartMonth,
    fiscalStartYear: fiscalYear,
    fiscalYearLabel: fiscalYearLabel(fiscalYear, client.fiscalYearStartMonth),
  };
}

/** Tope de tacos guardados que se leen para proponer: de sobra para años de cajas. */
const BOX_USES_LIMIT = 5000;

/**
 * Las etiquetas del ámbito (B-R11) y las demás de la asesoría (sugerencias).
 * Los anulados y los de otra asesoría no cuentan nunca. Con `viewer`, las de
 * los tacos que no ve (B-R20) cuentan para la propuesta pero no se sugieren:
 * con «una caja por cliente y año» llevan el nombre de un cliente que no es
 * suyo. Sin viewer (la «Caja nueva» del servidor), todas.
 */
async function boxUses(
  db: Prisma.TransactionClient,
  firmId: string,
  scope: BoxScope,
  viewer: TacoViewer | null,
): Promise<{ used: BoxUse[]; others: BoxUse[] }> {
  const filedWhere: Prisma.UploadBatchWhereInput = {
    advisoryFirmId: firmId,
    tacoNumber: { not: null },
    boxLabel: { not: null },
    voidedAt: null,
  };
  const orderBy: Prisma.UploadBatchOrderByWithRelationInput[] = [{ filedAt: "desc" }, { createdAt: "desc" }];
  const [filed, visible] = await Promise.all([
    db.uploadBatch.findMany({
      where: filedWhere,
      select: { id: true, clientId: true, origin: true, periodMonth: true, periodYear: true, boxLabel: true, filedAt: true, createdAt: true },
      orderBy,
      take: BOX_USES_LIMIT,
    }),
    viewer && viewer.role !== "ADMIN"
      ? db.uploadBatch.findMany({
        where: { AND: [filedWhere, uploadBatchVisibleWhere(viewer)] },
        select: { id: true },
        orderBy,
        take: BOX_USES_LIMIT,
      })
      : Promise.resolve(null),
  ]);
  const visibleIds = visible ? new Set(visible.map((taco) => taco.id)) : null;
  const used: BoxUse[] = [];
  const others: BoxUse[] = [];
  for (const taco of filed) {
    if (!taco.boxLabel) continue;
    const hidden = visibleIds != null && !visibleIds.has(taco.id);
    const use = { label: taco.boxLabel, filedAt: taco.filedAt ?? taco.createdAt, hidden };
    const inScope = scope.mode === "SHARED"
      || (scope.clientId == null
        ? taco.clientId == null && taco.periodYear === scope.fiscalStartYear
        : taco.clientId === scope.clientId && tacoFiscalStartYear(taco, scope.startMonth) === scope.fiscalStartYear);
    if (inScope) used.push(use);
    else if (!hidden) others.push(use);
  }
  return { used, others };
}

async function proposalFor(
  db: Prisma.TransactionClient,
  firmId: string,
  scope: BoxScope,
  viewer: TacoViewer | null,
): Promise<BoxProposal> {
  const { used, others } = await boxUses(db, firmId, scope, viewer);
  const proposal = proposeBoxLabels({
    mode: scope.mode,
    clientName: scope.clientName,
    fiscalYearLabel: scope.fiscalYearLabel,
    used,
    others,
  });
  return { mode: scope.mode, ...proposal, clientName: scope.clientName, fiscalYearLabel: scope.fiscalYearLabel };
}

/** La caja que se propone al guardar un taco (null si no es un taco de la asesoría). */
export async function boxProposalForTaco(viewer: TacoViewer, batchId: string): Promise<BoxProposal | null> {
  const scope = await boxScopeOfTaco(prisma, viewer.firmId, batchId);
  return scope ? proposalFor(prisma, viewer.firmId, scope, viewer) : null;
}

/** La caja que se propone al poner ubicación al papel de un cliente y ejercicio. */
export async function boxProposalForClientYear(viewer: TacoViewer, clientId: string, fiscalYear: number): Promise<BoxProposal | null> {
  const scope = await boxScopeOfClientYear(prisma, viewer.firmId, clientId, fiscalYear);
  return scope ? proposalFor(prisma, viewer.firmId, scope, viewer) : null;
}

/** «Caja nueva»: la calcula el servidor con el bloqueo de la asesoría ya
 *  tomado, para que dos a la vez no den la misma (B-R10). Cuentan todas las
 *  cajas: a quien pide solo le llega la etiqueta nueva. */
async function nextBoxLabel(tx: Prisma.TransactionClient, firmId: string, scope: BoxScope): Promise<string> {
  return (await proposalFor(tx, firmId, scope, null)).next;
}

// ── Guardar en caja o devolver (B-R10) ──────────────────────────────────────

/**
 * «Guardar en caja», «Cambiar de caja» o «Devuelto al cliente» de un taco
 * (subido o ARCHIVE). Cada cambio deja paperLocation en cada factura cuyo
 * papel está en el taco y cuyo texto cambia. Un taco vacío o sin dividir
 * también se guarda (sin auditoría: no tiene facturas).
 */
export async function fileTaco(input: {
  firmId: string;
  userId: string;
  batchId: string;
  destination: BoxDestination;
}): Promise<TacoEditResult<FiledTaco>> {
  let label: string | null = null;
  if (input.destination.kind === "box") {
    const normalized = normalizeBoxLabel(input.destination.label);
    if (!normalized.ok) return { error: normalized.error };
    label = normalized.label;
  }

  return runTacoEdit<FiledTaco>(async (tx) => {
    const batch = await lockBatch(tx, input.firmId, input.batchId);
    if (!batch || batch.tacoNumber == null) return { error: TACO_NOT_FOUND };
    if (batch.voidedAt) return { error: TACO_VOIDED };

    const rows = await lockArchiveRows(
      tx,
      input.firmId,
      Prisma.sql`a."paperBatchId" = ${batch.id} OR (a."uploadBatchId" = ${batch.id} AND a."paperBatchId" IS NULL)`,
    );
    const refs = await loadTacoRefs(tx, input.firmId, rows);
    refs.set(batch.id, tacoRefOf(batch));

    if (input.destination.kind === "newBox") {
      await lockFirmTacos(tx, input.firmId);
      const scope = await boxScopeOfTaco(tx, input.firmId, batch.id);
      if (!scope) return { error: TACO_NOT_FOUND };
      label = await nextBoxLabel(tx, input.firmId, scope);
    }

    const now = new Date();
    const returned = input.destination.kind === "returned";
    const updated = await tx.uploadBatch.update({
      where: { id: batch.id },
      data: returned
        ? { boxLabel: null, returnedAt: now, filedAt: now, filedById: input.userId }
        : { boxLabel: label, returnedAt: null, filedAt: now, filedById: input.userId },
      select: TACO_REF_SELECT,
    });
    const after = new Map(refs);
    after.set(batch.id, updated);

    await appendAuditLogs(
      paperLocationAudits(
        rows.map((row) => ({ row, before: locationOf(row, refs).text, after: locationOf(row, after).text })),
        input.userId,
      ),
      tx,
    );
    return {
      ok: true,
      tacoNumber: batch.tacoNumber,
      boxLabel: returned ? null : label,
      locationText: returned ? returnedText(now) : label ?? "",
    };
  });
}

// ── Era papel: crear taco (B-R15) ───────────────────────────────────────────

/**
 * Una tanda digital pasa a ser un taco: su nº y sus facturas «Por confirmar»
 * (de cualquier origen) pasan a papel del taco. Las electrónicas, las de
 * papel, las que guarda el cliente y las guardadas en otro taco se quedan
 * como están. Las páginas son las posiciones de la subida.
 */
export async function convertToTaco(input: {
  firmId: string;
  userId: string;
  batchId: string;
}): Promise<TacoEditResult<ConvertedTaco>> {
  return runTacoEdit<ConvertedTaco>(async (tx) => {
    const batch = await lockBatch(tx, input.firmId, input.batchId);
    if (!batch) return { error: BATCH_NOT_FOUND };
    if (batch.origin === "ARCHIVE") return { error: ARCHIVE_NOT_CONVERTED };
    if (batch.tacoNumber != null) return { error: alreadyTacoError(batch.tacoNumber) };

    const rows = await lockArchiveRows(tx, input.firmId, Prisma.sql`a."uploadBatchId" = ${batch.id}`);
    const refs = await loadTacoRefs(tx, input.firmId, rows);
    refs.set(batch.id, tacoRefOf(batch));

    const tacoNumber = await reserveTacoNumber(tx, input.firmId);
    const set = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "UploadBatch"
      SET "tacoNumber" = ${tacoNumber}, "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${batch.id} AND "tacoNumber" IS NULL
      RETURNING "id"`;
    if (set.length === 0) throw new TacoEditConflict();

    const toPaper = rows.filter((row) => row.originalMedium == null && !row.paperHeldByClient && row.paperBatchId == null);
    if (toPaper.length > 0) {
      const changed = await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: toPaper.map((row) => row.invoiceId) }, originalMedium: null },
        data: { originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: PAPER_TACO_REASON },
      });
      if (changed.count !== toPaper.length) throw new TacoEditConflict();
    }

    const after = new Map(refs);
    after.set(batch.id, { ...tacoRefOf(batch), tacoNumber });
    const converted = new Set(toPaper.map((row) => row.invoiceId));
    await appendAuditLogs(
      [
        ...toPaper.map((row) => ({
          invoiceId: row.invoiceId,
          userId: input.userId,
          field: "originalMedium",
          oldValue: null,
          newValue: "PAPER",
        })),
        ...paperLocationAudits(
          rows.map((row) => ({
            row,
            before: locationOf(row, refs).text,
            after: locationOf(converted.has(row.invoiceId) ? { ...row, originalMedium: "PAPER" } : row, after).text,
          })),
          input.userId,
        ),
      ],
      tx,
    );
    return {
      ok: true,
      tacoNumber,
      converted: toPaper.filter((row) => row.status !== "SPLIT_SOURCE").length,
    };
  });
}

// ── Poner ubicación y «Sacar del taco» (B-R14, B-R16) ───────────────────────

type ResolvedTarget = {
  clientId: string;
  startMonth: number;
  /** Las raíces de división de las elegidas: se amplía a sus familias. */
  rootIds: string[];
  /** Ejercicio del ámbito «a todas» (el de la pestaña). */
  fiscalYear: number | null;
  scope: boolean;
  moveInvoiceId: string | null;
};

async function rootsOf(ids: readonly string[]): Promise<string[]> {
  const roots = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up AS (
      SELECT i."id", i."splitFromId" FROM "Invoice" i WHERE i."id" = ANY(${[...ids]}::text[])
      UNION
      SELECT p."id", p."splitFromId" FROM "Invoice" p JOIN up ON p."id" = up."splitFromId"
    )
    SELECT "id" FROM up WHERE "splitFromId" IS NULL`;
  return roots.map((root) => root.id);
}

/** Las facturas de la elección, todas de un cliente de la asesoría (fuera
 *  del buzón). splitFromId no cambia nunca: las raíces se buscan fuera de la
 *  transacción, como en setOriginalMedium. */
async function resolvePlaceTarget(firmId: string, target: PlaceTarget): Promise<ResolvedTarget | { error: string }> {
  if ("clientId" in target) {
    const client = await prisma.client.findFirst({
      where: { id: target.clientId, advisoryFirmId: firmId, isUnclassifiedBucket: false },
      select: { id: true, fiscalYearStartMonth: true },
    });
    if (!client) return { error: INVOICES_NOT_FOUND };
    const [from, to] = fiscalYearRange(target.fiscalYear, client.fiscalYearStartMonth);
    const media = target.includeUnconfirmed
      ? Prisma.sql`(a."originalMedium" = 'PAPER'
          OR (a."originalMedium" IS NULL AND i."status"::text NOT IN (${Prisma.join(IN_ANALYSIS)})))`
      : Prisma.sql`a."originalMedium" = 'PAPER'`;
    // B-R13: papel (y, con la casilla, «Por confirmar» que no se está
    // analizando) sin ubicación, no rechazado, del ejercicio como lo agrupa el
    // archivo (archiveEntriesBetween): lo mismo que cuentan las cifras.
    const ids = await prisma.$queryRaw<{ id: string }[]>`
      SELECT i."id"
      FROM "Invoice" i
      JOIN "InvoiceArchive" a ON a."invoiceId" = i."id"
      LEFT JOIN "UploadBatch" ub ON ub."id" = a."uploadBatchId"
      WHERE i."clientId" = ${client.id}
        AND i."status"::text NOT IN ('SPLIT_SOURCE', 'PENDING_ROUTING', 'REJECTED')
        AND COALESCE(i."accountingPeriodYear", i."periodYear") * 12
          + COALESCE(i."accountingPeriodMonth", i."periodMonth") - 1 BETWEEN ${from} AND ${to}
        AND NOT a."paperHeldByClient"
        AND a."paperBatchId" IS NULL
        AND ub."tacoNumber" IS NULL
        AND ${media}
      LIMIT ${PLACE_PAPER_MAX_SCOPE + 1}`;
    if (ids.length === 0) return { error: NOTHING_WITHOUT_LOCATION };
    if (ids.length > PLACE_PAPER_MAX_SCOPE) return { error: TOO_MANY_IN_SCOPE };
    return {
      clientId: client.id,
      startMonth: client.fiscalYearStartMonth,
      rootIds: await rootsOf(ids.map((row) => row.id)),
      fiscalYear: target.fiscalYear,
      scope: true,
      moveInvoiceId: null,
    };
  }

  const ids = "moveInvoiceId" in target ? [target.moveInvoiceId] : [...new Set(target.invoiceIds)];
  if (ids.length === 0) return { error: INVOICES_NOT_FOUND };
  if (ids.length > PLACE_PAPER_MAX_SELECTED) return { error: TOO_MANY_SELECTED };
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids }, client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } },
    select: { clientId: true, client: { select: { fiscalYearStartMonth: true } } },
  });
  if (invoices.length !== ids.length) return { error: INVOICES_NOT_FOUND };
  if (new Set(invoices.map((invoice) => invoice.clientId)).size > 1) return { error: MIXED_CLIENTS };
  return {
    clientId: invoices[0].clientId,
    startMonth: invoices[0].client.fiscalYearStartMonth,
    rootIds: await rootsOf(ids),
    fiscalYear: null,
    scope: false,
    moveInvoiceId: "moveInvoiceId" in target ? target.moveInvoiceId : null,
  };
}

/** Las familias de las raíces (las raíces y todas sus partes) que son del
 *  cliente; con `lock`, bloqueadas en el orden de B-R21. Una subida «entre
 *  varias» que se separa sola deja una familia con hijas de varios clientes y
 *  la raíz en el buzón: el papel de cada hija es de su cliente, y lo de los
 *  demás no se toca. */
async function familyRows(
  db: Prisma.TransactionClient,
  firmId: string,
  clientId: string,
  rootIds: readonly string[],
  lock: boolean,
): Promise<ArchiveStateRow[]> {
  if (lock) {
    await db.$queryRaw`
      SELECT "invoiceId" FROM "InvoiceArchive" WHERE "invoiceId" = ANY(${[...rootIds]}::text[]) ORDER BY "invoiceId" FOR UPDATE`;
  }
  return db.$queryRaw<ArchiveStateRow[]>`
    WITH RECURSIVE fam AS (
      SELECT unnest(${[...rootIds]}::text[]) AS id
      UNION
      SELECT i."id" FROM "Invoice" i JOIN fam ON i."splitFromId" = fam.id
    )
    SELECT ${ARCHIVE_STATE_COLUMNS}
    FROM "InvoiceArchive" a
    JOIN "Invoice" i ON i."id" = a."invoiceId"
    JOIN "Client" c ON c."id" = i."clientId"
    WHERE a."invoiceId" IN (SELECT id FROM fam) AND c."advisoryFirmId" = ${firmId} AND i."clientId" = ${clientId}
    ORDER BY a."invoiceId"
    ${lock ? Prisma.sql`FOR UPDATE OF a` : Prisma.empty}`;
}

type PlaceVerdict = "unconfirmed" | "paper" | "electronic" | "inTaco" | "rejected" | "analyzing";

const MAX_SPLIT_DEPTH = 100;

/**
 * Las filas cuya familia de división tiene alguna factura que espera su
 * análisis o se está analizando. El análisis aún puede decir que una «Por
 * confirmar» es electrónica, y una vez puesta en papel a mano (MANUAL) ya no
 * la cambia (R11): como setOriginalMedium, la familia entera espera.
 */
function analyzingFamilies(rows: readonly ArchiveStateRow[]): Set<string> {
  const parentOf = new Map(rows.map((row) => [row.invoiceId, row.splitFromId]));
  const rootOf = (id: string): string => {
    let current = id;
    for (let depth = 0; depth < MAX_SPLIT_DEPTH; depth++) {
      const parent = parentOf.get(current);
      if (parent == null) return current;
      current = parent;
    }
    return current;
  };
  const inAnalysis: readonly string[] = IN_ANALYSIS;
  const busy = new Set(rows.filter((row) => inAnalysis.includes(row.status)).map((row) => rootOf(row.invoiceId)));
  return new Set(rows.filter((row) => busy.has(rootOf(row.invoiceId))).map((row) => row.invoiceId));
}

/**
 * Qué pasa con cada fila (B-R14). Con «Sacar del taco», vale el papel o lo
 * «Por confirmar» aunque tenga taco. Si no, solo sin taco: «Lo guarda el
 * cliente» no es estar en un taco, así que también se puede ubicar (por si os
 * lo ha dado). En el ámbito «a todas», las rechazadas se saltan. Lo «Por
 * confirmar» que aún se analiza (analyzingFamilies) se salta siempre.
 */
function placeVerdict(
  row: ArchiveStateRow,
  refs: ReadonlyMap<string, TacoRef>,
  target: ResolvedTarget,
  analyzing: ReadonlySet<string>,
): PlaceVerdict {
  if (row.originalMedium === "ELECTRONIC") return "electronic";
  if (!target.moveInvoiceId) {
    if (target.scope && row.status === "REJECTED") return "rejected";
    if (!row.paperHeldByClient && locationOf(row, refs).tacoId != null) return "inTaco";
  }
  if (row.originalMedium == null) return analyzing.has(row.invoiceId) ? "analyzing" : "unconfirmed";
  return "paper";
}

function placeVerdicts(
  rows: readonly ArchiveStateRow[],
  refs: ReadonlyMap<string, TacoRef>,
  target: ResolvedTarget,
): Map<string, PlaceVerdict> {
  const analyzing = analyzingFamilies(rows);
  return new Map(rows.map((row) => [row.invoiceId, placeVerdict(row, refs, target, analyzing)]));
}

function countPlace(rows: readonly ArchiveStateRow[], verdicts: ReadonlyMap<string, PlaceVerdict>): PlaceCount {
  const count: PlaceCount = {
    placeable: 0,
    unconfirmed: 0,
    paper: 0,
    skipped: { electronic: 0, inTaco: 0, rejected: 0, analyzing: 0 },
  };
  for (const row of rows) {
    // La original de una división no se ve en el archivo: cuentan sus partes.
    if (row.status === "SPLIT_SOURCE") continue;
    const verdict = verdicts.get(row.invoiceId);
    if (verdict === "unconfirmed" || verdict === "paper") {
      count.placeable++;
      count[verdict]++;
    } else if (verdict) {
      count.skipped[verdict]++;
    }
  }
  return count;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** «45 electrónicas · 5 ya en un taco · 2 se están analizando». */
export function skippedText(skipped: PlaceCount["skipped"]): string {
  const parts = [
    skipped.electronic > 0 ? plural(skipped.electronic, "electrónica", "electrónicas") : null,
    skipped.inTaco > 0 ? `${skipped.inTaco} ya en un taco` : null,
    skipped.rejected > 0 ? plural(skipped.rejected, "rechazada", "rechazadas") : null,
    skipped.analyzing > 0 ? plural(skipped.analyzing, "se está analizando", "se están analizando") : null,
  ].filter((part): part is string => part != null);
  return parts.join(" · ");
}

function nothingToPlaceError(count: PlaceCount): string {
  const why = skippedText(count.skipped);
  return why ? `Ninguna de las elegidas se puede ubicar: ${why}.` : "Ninguna de las elegidas se puede ubicar.";
}

/** Valida la elección con sus filas ya leídas: «Sacar del taco» pide que la
 *  factura tenga el papel en un taco. */
function checkMove(rows: readonly ArchiveStateRow[], refs: ReadonlyMap<string, TacoRef>, target: ResolvedTarget): string | null {
  if (!target.moveInvoiceId) return null;
  const row = rows.find((candidate) => candidate.invoiceId === target.moveInvoiceId);
  if (!row) return INVOICES_NOT_FOUND;
  return locationOf(row, refs).tacoId == null ? NOT_IN_A_TACO : null;
}

/** Cuántas se ubicarán y cuántas se quedan como están, sin bloquear nada. */
export async function previewPlacePaper(input: { firmId: string; target: PlaceTarget }): Promise<TacoEditResult<PlaceCount>> {
  const target = await resolvePlaceTarget(input.firmId, input.target);
  if ("error" in target) return target;
  const rows = await familyRows(prisma, input.firmId, target.clientId, target.rootIds, false);
  if (rows.length === 0) return { error: INVOICES_NOT_FOUND };
  const refs = await loadTacoRefs(prisma, input.firmId, rows);
  const moveError = checkMove(rows, refs, target);
  if (moveError) return { error: moveError };
  return { ok: true, ...countPlace(rows, placeVerdicts(rows, refs, target)) };
}

/** El ejercicio del papel ubicado a mano: el de la pestaña («a todas») o, en
 *  una selección, el de la mayoría de las facturas (empate: el más reciente). */
function placeFiscalYear(rows: readonly ArchiveStateRow[], target: ResolvedTarget): number {
  if (target.fiscalYear != null) return target.fiscalYear;
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.status === "SPLIT_SOURCE") continue;
    const { year, month } = invoicePeriod(row);
    const startYear = fiscalYearOf(year, month, target.startMonth).startYear;
    counts.set(startYear, (counts.get(startYear) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [year, n] of counts) {
    if (best == null || n > (counts.get(best) ?? 0) || (n === counts.get(best) && year > best)) best = year;
  }
  return best ?? new Date().getUTCFullYear();
}

/**
 * El taco ARCHIVE de destino (B-R16), con el bloqueo de la asesoría ya
 * tomado: con una caja escrita, el del mismo cliente, ejercicio y caja (sin
 * tildes ni mayúsculas), guardado y sin anular, si lo hay; si no, o con
 * «Caja nueva» o «Se lo devolvemos hoy», uno nuevo ya guardado.
 */
async function archiveTacoFor(
  tx: Prisma.TransactionClient,
  input: { firmId: string; userId: string; clientId: string; fiscalYear: number; destination: BoxDestination; now: Date },
): Promise<TacoRef | { error: string }> {
  // Antes de buscar la caja: dos «Poner ubicación» a la vez en la misma caja
  // nueva comparten el taco en vez de crear uno cada una.
  await lockFirmTacos(tx, input.firmId);
  let label: string | null = null;
  if (input.destination.kind === "box") {
    const normalized = normalizeBoxLabel(input.destination.label);
    if (!normalized.ok) return { error: normalized.error };
    label = normalized.label;
    const key = boxLabelKey(label);
    const candidates = await tx.uploadBatch.findMany({
      where: {
        advisoryFirmId: input.firmId,
        clientId: input.clientId,
        origin: "ARCHIVE",
        periodYear: input.fiscalYear,
        voidedAt: null,
        returnedAt: null,
        boxLabel: { not: null },
      },
      select: { id: true, boxLabel: true },
      orderBy: { createdAt: "asc" },
    });
    const same = candidates.find((candidate) => candidate.boxLabel != null && boxLabelKey(candidate.boxLabel) === key);
    if (same) {
      const [locked] = await tx.$queryRaw<LockedBatch[]>`
        SELECT "id", "clientId", "origin"::text AS "origin", "tacoNumber", "wholePdf", "fileCount",
               "boxLabel", "returnedAt", "filedAt", "voidedAt"
        FROM "UploadBatch"
        WHERE "id" = ${same.id} AND "voidedAt" IS NULL AND "returnedAt" IS NULL AND "boxLabel" IS NOT NULL
        FOR UPDATE`;
      if (locked?.boxLabel && boxLabelKey(locked.boxLabel) === key) return tacoRefOf(locked);
    }
  } else if (input.destination.kind === "newBox") {
    const scope = await boxScopeOfClientYear(tx, input.firmId, input.clientId, input.fiscalYear);
    if (!scope) return { error: INVOICES_NOT_FOUND };
    label = await nextBoxLabel(tx, input.firmId, scope);
  }

  const tacoNumber = await reserveTacoNumber(tx, input.firmId);
  const returned = input.destination.kind === "returned";
  return tx.uploadBatch.create({
    data: {
      advisoryFirmId: input.firmId,
      clientId: input.clientId,
      origin: "ARCHIVE",
      createdById: input.userId,
      fileCount: 0,
      periodYear: input.fiscalYear,
      tacoNumber,
      ...(returned ? { returnedAt: input.now } : { boxLabel: label }),
      filedAt: input.now,
      filedById: input.userId,
    },
    select: TACO_REF_SELECT,
  });
}

/**
 * «Poner ubicación» (una selección o todo lo sin ubicación de un cliente y
 * ejercicio) o «Sacar del taco» (una factura): cada factura con su familia
 * de división. Se ubican las que valen y se saltan las demás; las «Por
 * confirmar» pasan a papel (MANUAL). Nunca toca la tanda de llegada, la
 * posición ni la llegada.
 */
export async function placePaper(input: {
  firmId: string;
  userId: string;
  target: PlaceTarget;
  destination: PlaceDestination;
}): Promise<TacoEditResult<PlacedPaper>> {
  if (input.destination.kind === "box") {
    const normalized = normalizeBoxLabel(input.destination.label);
    if (!normalized.ok) return { error: normalized.error };
  }
  const target = await resolvePlaceTarget(input.firmId, input.target);
  if ("error" in target) return target;
  const destination = input.destination;

  return runTacoEdit<PlacedPaper>(async (tx) => {
    // Bloquear y después volver a leer: dos «Poner ubicación» a la vez sobre
    // las mismas facturas no dejan un taco vacío ni un «antes» falso.
    const rows = await familyRows(tx, input.firmId, target.clientId, target.rootIds, true);
    if (rows.length === 0) return { error: INVOICES_NOT_FOUND };
    const refs = await loadTacoRefs(tx, input.firmId, rows);
    const moveError = checkMove(rows, refs, target);
    if (moveError) return { error: moveError };

    const verdicts = placeVerdicts(rows, refs, target);
    const count = countPlace(rows, verdicts);
    const valid = rows.filter((row) => {
      const verdict = verdicts.get(row.invoiceId);
      return verdict === "unconfirmed" || verdict === "paper";
    });
    if (count.placeable === 0 || valid.length === 0) return { error: nothingToPlaceError(count) };

    const now = new Date();
    let taco: TacoRef | null = null;
    if (destination.kind !== "client") {
      const created = await archiveTacoFor(tx, {
        firmId: input.firmId,
        userId: input.userId,
        clientId: target.clientId,
        fiscalYear: placeFiscalYear(valid, target),
        destination,
        now,
      });
      if ("error" in created) return created;
      taco = created;
    }

    // Por grupos del taco leído: si alguna fila ya no tiene el de antes, se deshace todo.
    const byPaper = new Map<string | null, string[]>();
    for (const row of valid) byPaper.set(row.paperBatchId, [...(byPaper.get(row.paperBatchId) ?? []), row.invoiceId]);
    for (const [paperBatchId, ids] of byPaper) {
      const written = await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: ids }, paperBatchId },
        data: taco ? { paperBatchId: taco.id, paperHeldByClient: false } : { paperHeldByClient: true },
      });
      if (written.count !== ids.length) throw new TacoEditConflict();
    }
    const unconfirmed = valid.filter((row) => row.originalMedium == null);
    if (unconfirmed.length > 0) {
      const written = await tx.invoiceArchive.updateMany({
        where: { invoiceId: { in: unconfirmed.map((row) => row.invoiceId) }, originalMedium: null },
        data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: MANUAL_REASON },
      });
      if (written.count !== unconfirmed.length) throw new TacoEditConflict();
    }

    const after = new Map(refs);
    if (taco) after.set(taco.id, taco);
    await appendAuditLogs(
      [
        ...unconfirmed.map((row) => ({
          invoiceId: row.invoiceId,
          userId: input.userId,
          field: "originalMedium",
          oldValue: null,
          newValue: "PAPER",
        })),
        ...paperLocationAudits(
          valid.map((row) => ({
            row,
            before: locationOf(row, refs).text,
            after: locationOf(
              {
                ...row,
                originalMedium: "PAPER",
                paperHeldByClient: !taco,
                paperBatchId: taco ? taco.id : row.paperBatchId,
              },
              after,
            ).text,
          })),
          input.userId,
        ),
      ],
      tx,
    );

    const locationText = !taco ? "Lo guarda el cliente" : taco.boxLabel ?? (taco.returnedAt ? returnedText(taco.returnedAt) : "");
    return { ok: true, ...count, tacoNumber: taco?.tacoNumber ?? null, locationText };
  });
}

// ── Anular un taco (B-R22) ──────────────────────────────────────────────────

/**
 * Un taco subido por error y sin facturas vivas (ninguna, o todas
 * rechazadas; la original de una división no cuenta, sus partes sí) ni papel
 * puesto en él desde fuera. Conserva su nº; no se borra nada. La subida toma
 * la tanda FOR SHARE: o su factura entra antes y aquí se ve, o va después y
 * no entra.
 */
export async function voidTaco(input: {
  firmId: string;
  userId: string;
  batchId: string;
  reason: string;
}): Promise<TacoEditResult<VoidedTaco>> {
  const reason = input.reason.replace(/\s+/g, " ").trim();
  const length = [...reason].length;
  if (length < VOID_REASON_MIN || length > VOID_REASON_MAX) return { error: VOID_REASON_ERROR };

  return runTacoEdit<VoidedTaco>(async (tx) => {
    const batch = await lockBatch(tx, input.firmId, input.batchId);
    if (!batch || batch.tacoNumber == null) return { error: TACO_NOT_FOUND };
    if (batch.origin === "ARCHIVE") return { error: VOID_ARCHIVE };
    if (batch.voidedAt) return { error: VOID_ALREADY };

    const rows = await lockArchiveRows(
      tx,
      input.firmId,
      Prisma.sql`a."uploadBatchId" = ${batch.id} OR a."paperBatchId" = ${batch.id}`,
    );
    const alive = rows.some((row) => row.uploadBatchId === batch.id && row.status !== "REJECTED" && row.status !== "SPLIT_SOURCE");
    if (alive) return { error: VOID_ALIVE_INVOICES };
    if (rows.some((row) => row.paperBatchId === batch.id)) return { error: VOID_PAPER_FROM_OUTSIDE };

    const refs = await loadTacoRefs(tx, input.firmId, rows);
    refs.set(batch.id, tacoRefOf(batch));
    const updated = await tx.uploadBatch.update({
      where: { id: batch.id },
      data: { voidedAt: new Date(), voidedById: input.userId, voidReason: reason },
      select: TACO_REF_SELECT,
    });
    const after = new Map(refs);
    after.set(batch.id, updated);
    await appendAuditLogs(
      paperLocationAudits(
        rows.map((row) => ({ row, before: locationOf(row, refs).text, after: locationOf(row, after).text })),
        input.userId,
      ),
      tx,
    );
    return { ok: true, tacoNumber: batch.tacoNumber };
  });
}

// ── Completar un taco (B-R23) ───────────────────────────────────────────────

/**
 * Hace sitio al final de un taco de factura a factura para los ficheros que
 * faltan: sube fileCount (la guarda de la 13 deja que suba, nunca que baje).
 * Solo si sigue teniendo los que se leyeron: dos «Completar» a la vez no se
 * pisan. Sin auditoría: no cambia ninguna factura.
 */
export async function extendTaco(input: {
  firmId: string;
  userId: string;
  batchId: string;
  expectedFileCount: number;
  addCount: number;
}): Promise<TacoEditResult<ExtendedTaco>> {
  const { expectedFileCount, addCount } = input;
  if (!Number.isInteger(addCount) || addCount < 1 || !Number.isInteger(expectedFileCount) || expectedFileCount < 0) {
    return { error: EXTEND_CONFLICT };
  }
  if (expectedFileCount + addCount > UPLOAD_BATCH_MAX_FILES) return { error: EXTEND_TOO_MANY };

  // Con el periodo del lote cerrado, /api/uploads rechaza cada fichero
  // (ERR-UPLOAD-004) y las páginas añadidas se quedarían para siempre «sin
  // factura»: fileCount no baja nunca. Es la misma comprobación que la subida.
  const lot = await prisma.uploadBatch.findFirst({
    where: { id: input.batchId, advisoryFirmId: input.firmId },
    select: { clientId: true, periodMonth: true, periodYear: true },
  });
  if (lot?.clientId && lot.periodMonth != null) {
    const open = await assertUploadPeriodOpen(lot.clientId, lot.periodMonth, lot.periodYear);
    if (!open.ok) return { error: open.error.message };
  }

  return runTacoEdit<ExtendedTaco>(async (tx) => {
    const [grown] = await tx.$queryRaw<{ fileCount: number }[]>`
      UPDATE "UploadBatch"
      SET "fileCount" = "fileCount" + ${addCount}, "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = ${input.batchId} AND "advisoryFirmId" = ${input.firmId}
        AND "fileCount" = ${expectedFileCount}
        AND "voidedAt" IS NULL AND NOT "wholePdf" AND "origin" = 'UPLOAD' AND "tacoNumber" IS NOT NULL
      RETURNING "fileCount"`;
    if (grown) return { ok: true, fileCount: grown.fileCount, firstNewPosition: expectedFileCount + 1 };

    // Por qué no: lo que dice el formulario.
    const batch = await tx.uploadBatch.findFirst({
      where: { id: input.batchId, advisoryFirmId: input.firmId },
      select: { tacoNumber: true, origin: true, wholePdf: true, voidedAt: true },
    });
    if (!batch) return { error: TACO_NOT_FOUND };
    if (batch.voidedAt) return { error: TACO_VOIDED };
    if (batch.wholePdf) return { error: EXTEND_WHOLE_PDF };
    if (batch.tacoNumber == null || batch.origin !== "UPLOAD") return { error: EXTEND_NOT_A_TACO };
    return { error: EXTEND_CONFLICT };
  });
}
