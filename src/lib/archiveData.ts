/**
 * Lectura del archivo: los ejercicios de un cliente, su archivo de un
 * ejercicio (ordenado, filtrado y paginado, con sus cifras), la ficha de una
 * factura, el original de verdad, el buscador «¿Dónde está?» y las cifras de
 * la asesoría. Quien llama ya ha comprobado el acceso (archiveAccess.ts); aun
 * así, todo va acotado a la asesoría.
 *
 * Como el listado de facturas, se ordena, se filtra y se pagina en memoria
 * por cliente y ejercicio (unos miles de filas como mucho): el orden del
 * archivo (compareArchiveOrder) y la búsqueda sin tildes no se pueden pedir a
 * Postgres sin extensiones.
 */
import { Prisma, type InvoiceStatus, type InvoiceType, type OriginalMedium, type OriginalMediumSource, type RetentionHoldReason } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ArchiveScope } from "@/lib/archiveAccess";
import {
  archiveWarnings,
  compareArchiveOrder,
  fiscalYearOf,
  fiscalYearRange,
  flagLateRegistrations,
  retainUntil,
  suggestRetentionHold,
  type ArchiveOrderRow,
  type ArchiveWarningCode,
  type FiscalYear,
} from "@/lib/archiveRules";
import {
  addToArchiveCell,
  ARCHIVE_EXCLUDED_STATUSES,
  archiveFiscalYearOf,
  buildArchiveMetrics,
  emptyArchiveCell,
  type ArchiveCell,
  type ArchiveMetrics,
  type ArchiveMetricsRow,
} from "@/lib/archiveMetrics";
import { parseArchiveQuery, type ArchiveQuery } from "@/lib/archiveSearchQuery";
import { formatRegisterNumber, type RegisterQuery } from "@/lib/registerNumbers";
import { splitPartReasonLabel } from "@/lib/originalMedium";
import { hasOwnAccountingPeriod, invoicePeriod, periodIndex, periodLabel, type PeriodTypeName } from "@/lib/period";
import { matchesSearch, normalizeSearch, pageWindow, PAGE_SIZE, type PageWindow } from "@/lib/listing";
import { amountSearchVariants, MAX_IDS_IN_QUERY } from "@/lib/invoiceSearch";
import { inIdOrder, invoicePageIds, matchingInvoiceIds } from "@/lib/invoiceListing";

/** Tope de niveles al recorrer una división: en la práctica son uno o dos. */
const MAX_SPLIT_DEPTH = 100;

// ── Lo que se lee de cada factura ───────────────────────────────────────────

const ARCHIVE_ROW_SELECT = {
  id: true,
  clientId: true,
  status: true,
  type: true,
  typeUnconfirmed: true,
  periodType: true,
  periodMonth: true,
  periodYear: true,
  accountingPeriodMonth: true,
  accountingPeriodYear: true,
  invoiceNumber: true,
  invoiceDate: true,
  totalAmount: true,
  currency: true,
  issuerName: true,
  issuerCif: true,
  receiverName: true,
  receiverCif: true,
  filename: true,
  createdAt: true,
  splitFromId: true,
  rejectionReason: true,
  archive: {
    select: {
      receivedAt: true,
      uploadPosition: true,
      splitPart: true,
      paperHeldByClient: true,
      originalMedium: true,
      originalMediumSource: true,
      originalMediumReason: true,
      originalDocumentId: true,
      registerSeriesId: true,
      registerNumber: true,
      registeredAt: true,
      registerSeries: { select: { type: true, year: true } },
      retentionHold: true,
      retentionHoldReason: true,
    },
  },
} satisfies Prisma.InvoiceSelect;

type ArchiveRecord = Prisma.InvoiceGetPayload<{ select: typeof ARCHIVE_ROW_SELECT }>;
type ArchiveRowData = NonNullable<ArchiveRecord["archive"]>;

/** La fila de archivo; la crea un trigger, pero el tipo de Prisma la deja
 *  opcional: sin ella, lo de una factura recién subida. */
function archiveOf(record: ArchiveRecord): ArchiveRowData {
  return record.archive ?? {
    receivedAt: record.createdAt,
    uploadPosition: null,
    splitPart: 0,
    paperHeldByClient: false,
    originalMedium: null,
    originalMediumSource: null,
    originalMediumReason: null,
    originalDocumentId: null,
    registerSeriesId: null,
    registerNumber: null,
    registeredAt: null,
    registerSeries: null,
    retentionHold: false,
    retentionHoldReason: null,
  };
}

/** Una factura del archivo con lo que se calcula una sola vez. */
type ArchiveEntry = {
  record: ArchiveRecord;
  archive: ArchiveRowData;
  order: ArchiveOrderRow;
  /** El periodo de deducción (su primer mes, R2): el mismo para el orden
   *  (compareArchiveOrder) y para los subtítulos. */
  periodKey: string;
  periodLabel: string;
  total: number | null;
  registerLabel: string | null;
};

/** ¿Va en un lote trimestral sin periodo contable propio? Abarca el trimestre. */
function coversQuarter(record: ArchiveRecord): boolean {
  return record.periodType === "QUARTERLY" && !hasOwnAccountingPeriod(record);
}

/** Etiqueta del periodo de deducción: el contable propio es un mes; si no,
 *  el lote («T1 2026» en uno trimestral). */
function archivePeriodLabel(record: ArchiveRecord): string {
  if (coversQuarter(record)) return periodLabel("QUARTERLY", record.periodMonth, record.periodYear);
  const { month, year } = invoicePeriod(record);
  return periodLabel("MONTHLY", month, year);
}

/**
 * Una sola etiqueta por periodo: en el mismo primer mes pueden ir el lote del
 * T3 y una factura del T2 contabilizada en julio («T3 2026» y «Julio 2026»).
 * Va la del trimestre si alguna factura lo abarca; si no, la del mes.
 */
function withPeriodGroupLabels(entries: readonly ArchiveEntry[]): ArchiveEntry[] {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (!labels.has(entry.periodKey) || coversQuarter(entry.record)) labels.set(entry.periodKey, entry.periodLabel);
  }
  return entries.map((entry) => ({ ...entry, periodLabel: labels.get(entry.periodKey) ?? entry.periodLabel }));
}

function toEntry(record: ArchiveRecord): ArchiveEntry {
  const archive = archiveOf(record);
  const { month, year } = invoicePeriod(record);
  const label = archivePeriodLabel(record);
  return {
    record,
    archive,
    order: {
      id: record.id,
      type: record.type,
      periodType: record.periodType,
      periodMonth: record.periodMonth,
      periodYear: record.periodYear,
      accountingPeriodMonth: record.accountingPeriodMonth,
      accountingPeriodYear: record.accountingPeriodYear,
      receivedAt: archive.receivedAt,
      uploadPosition: archive.uploadPosition,
      splitPart: archive.splitPart,
      createdAt: record.createdAt,
      invoiceDate: record.invoiceDate,
      invoiceNumber: record.invoiceNumber,
    },
    periodKey: String(periodIndex(year, month)),
    periodLabel: label,
    total: record.totalAmount != null ? Number(record.totalAmount) : null,
    registerLabel: archive.registerNumber != null && archive.registerSeries
      ? formatRegisterNumber(archive.registerSeries, archive.registerNumber)
      : null,
  };
}

function metricsRowOf(entry: ArchiveEntry): ArchiveMetricsRow {
  const { record, archive } = entry;
  return {
    clientId: record.clientId,
    type: record.type,
    status: record.status,
    periodType: record.periodType,
    periodMonth: record.periodMonth,
    periodYear: record.periodYear,
    accountingPeriodMonth: record.accountingPeriodMonth,
    accountingPeriodYear: record.accountingPeriodYear,
    medium: archive.originalMedium,
    registered: archive.registerNumber != null,
    retentionHold: archive.retentionHold,
    lastInvoiceDate: record.invoiceDate,
    count: 1,
  };
}

/** Tercero que se enseña: el emisor en una recibida, el receptor en una emitida. */
function thirdParty(record: ArchiveRecord): { name: string | null; cif: string | null } {
  return record.type === "SALE"
    ? { name: record.receiverName, cif: record.receiverCif }
    : { name: record.issuerName, cif: record.issuerCif };
}

/** Las facturas de esos ids, por trozos: un `IN` con más de MAX_IDS_IN_QUERY
 *  parámetros falla. */
async function findArchiveRecords(ids: readonly string[]): Promise<ArchiveRecord[]> {
  const records: ArchiveRecord[] = [];
  for (let start = 0; start < ids.length; start += MAX_IDS_IN_QUERY) {
    const chunk = ids.slice(start, start + MAX_IDS_IN_QUERY);
    records.push(...await prisma.invoice.findMany({ where: { id: { in: chunk } }, select: ARCHIVE_ROW_SELECT }));
  }
  return records;
}

// ── Divisiones ──────────────────────────────────────────────────────────────

export type SplitFamilyPosition = {
  rootId: string;
  /** «Parte 2 de 3»: posición entre las partes que se ven (sin las que se
   *  volvieron a dividir), por splitPart. */
  index: number;
  count: number;
};

/**
 * La familia de cada parte: su raíz y su posición entre las partes que se
 * ven. splitPart no vale para «Parte 2 de 3»: una parte que se vuelve a
 * dividir deja un hueco y sus hijas siguen detrás.
 */
async function splitFamilies(partIds: readonly string[]): Promise<Map<string, SplitFamilyPosition>> {
  const positions = new Map<string, SplitFamilyPosition>();
  if (partIds.length === 0) return positions;
  const members = await prisma.$queryRaw<{ root: string; id: string; splitPart: number | null; status: string }[]>`
    WITH RECURSIVE up AS (
      SELECT i."id", i."splitFromId", 0 AS depth FROM "Invoice" i
      WHERE i."id" = ANY(${[...partIds]}::text[]) AND i."splitFromId" IS NOT NULL
      UNION ALL
      SELECT p."id", p."splitFromId", up.depth + 1
      FROM "Invoice" p JOIN up ON p."id" = up."splitFromId"
      WHERE up.depth < ${MAX_SPLIT_DEPTH}
    ), roots AS (
      SELECT DISTINCT "id" AS root FROM up WHERE "splitFromId" IS NULL
    ), fam AS (
      SELECT roots.root, c."id", 0 AS depth FROM roots JOIN "Invoice" c ON c."splitFromId" = roots.root
      UNION ALL
      SELECT fam.root, c."id", fam.depth + 1
      FROM fam JOIN "Invoice" c ON c."splitFromId" = fam."id"
      WHERE fam.depth < ${MAX_SPLIT_DEPTH}
    )
    SELECT fam.root, fam."id", a."splitPart", i."status"::text AS status
    FROM fam
    JOIN "Invoice" i ON i."id" = fam."id"
    LEFT JOIN "InvoiceArchive" a ON a."invoiceId" = fam."id"`;

  const byRoot = new Map<string, typeof members>();
  for (const member of members) {
    if (member.status === "SPLIT_SOURCE") continue;
    const list = byRoot.get(member.root) ?? [];
    list.push(member);
    byRoot.set(member.root, list);
  }
  for (const [rootId, list] of byRoot) {
    list.sort((a, b) => (a.splitPart ?? 0) - (b.splitPart ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    list.forEach((member, i) => positions.set(member.id, { rootId, index: i + 1, count: list.length }));
  }
  return positions;
}

/** La raíz de una división (la factura que se dividió primero), o null si la
 *  factura no es una parte. */
async function splitRootOf(invoiceId: string): Promise<string | null> {
  const [root] = await prisma.$queryRaw<{ id: string; depth: number }[]>`
    WITH RECURSIVE up AS (
      SELECT "id", "splitFromId", 0 AS depth FROM "Invoice" WHERE "id" = ${invoiceId}
      UNION ALL
      SELECT p."id", p."splitFromId", up.depth + 1
      FROM "Invoice" p JOIN up ON p."id" = up."splitFromId"
      WHERE up.depth < ${MAX_SPLIT_DEPTH}
    )
    SELECT "id", depth FROM up WHERE "splitFromId" IS NULL`;
  return root && root.depth > 0 ? root.id : null;
}

/** «Registrada tarde» necesita la serie entera, no solo lo que se enseña. */
async function lateRegistrations(seriesIds: readonly string[]): Promise<Set<string>> {
  if (seriesIds.length === 0) return new Set();
  const rows = await prisma.invoiceArchive.findMany({
    where: { registerSeriesId: { in: [...seriesIds] } },
    select: {
      invoiceId: true,
      registerSeriesId: true,
      registerNumber: true,
      invoice: { select: { periodMonth: true, periodYear: true, accountingPeriodMonth: true, accountingPeriodYear: true } },
    },
  });
  return flagLateRegistrations(rows.map((row) => ({
    ...row.invoice,
    id: row.invoiceId,
    registerSeriesId: row.registerSeriesId,
    registerNumber: row.registerNumber,
  })));
}

// ── Ejercicios de un cliente ────────────────────────────────────────────────

/** Ejercicios en los que el cliente tiene facturas en el archivo, del más
 *  reciente al más antiguo. */
export async function archiveFiscalYears(clientId: string, fiscalYearStartMonth: number): Promise<FiscalYear[]> {
  const periods = await prisma.invoice.groupBy({
    by: ["periodMonth", "periodYear", "accountingPeriodMonth", "accountingPeriodYear"],
    where: { clientId, status: { notIn: ARCHIVE_EXCLUDED_STATUSES } },
  });
  const years = new Map<number, FiscalYear>();
  for (const period of periods) {
    const { month, year } = invoicePeriod(period);
    const fiscalYear = fiscalYearOf(year, month, fiscalYearStartMonth);
    years.set(fiscalYear.startYear, fiscalYear);
  }
  return [...years.values()].sort((a, b) => b.startYear - a.startYear);
}

// ── Archivo de un cliente y ejercicio ───────────────────────────────────────

export type ArchiveTypeFilter = "todas" | "recibidas" | "emitidas";
export type ArchiveMediumFilter = "todos" | "electronico" | "papel" | "por-confirmar";

export type ClientArchiveFilters = {
  type?: ArchiveTypeFilter;
  medium?: ArchiveMediumFilter;
  includeRejected?: boolean;
  q?: string;
};

export type ArchiveRowWarning = { code: ArchiveWarningCode | "split_part"; label: string };

export type ClientArchiveRow = {
  invoiceId: string;
  status: InvoiceStatus;
  type: InvoiceType;
  typeUnconfirmed: boolean;
  /** Subtítulo de la tabla: cambia con el periodo de deducción. */
  periodKey: string;
  periodLabel: string;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  totalAmount: number | null;
  currency: string | null;
  thirdPartyName: string | null;
  thirdPartyCif: string | null;
  receivedAt: Date;
  /** «R-2026/0153», o null si aún no se ha exportado a A3. */
  registerNumber: string | null;
  registeredAt: Date | null;
  /** null = «Por confirmar». */
  medium: OriginalMedium | null;
  mediumSource: OriginalMediumSource | null;
  mediumReason: string | null;
  mediumReasonLabel: string | null;
  paperHeldByClient: boolean;
  retentionHold: boolean;
  retentionHoldReason: RetentionHoldReason | null;
  /** null con «conservar más». */
  retainUntil: Date | null;
  rejectionReason: string | null;
  /** El original en otro formato (Word, Excel…), si lo hay. */
  originalDocument: { filename: string; fileType: string } | null;
  /** Si es una parte de una división. */
  split: SplitFamilyPosition | null;
  warnings: ArchiveRowWarning[];
};

export type ArchivePeriodGroup = { key: string; label: string; count: number };

export type ClientArchive = {
  client: { id: string; name: string; cif: string; fiscalYearStartMonth: number };
  /** Los ejercicios con facturas, del más reciente al más antiguo. */
  fiscalYears: FiscalYear[];
  fiscalYear: FiscalYear;
  /** Cifras de todo el ejercicio, sin los filtros: las rechazadas van aparte
   *  (summary.rejected) y lo que falta por validar, en pendingValidation. */
  summary: ArchiveCell;
  /** Los periodos de lo filtrado, en orden, con cuántas facturas tiene cada uno. */
  periods: ArchivePeriodGroup[];
  rows: ClientArchiveRow[];
  window: PageWindow;
  /** Las facturas de lo filtrado, en orden y como mucho `selectionLimit`:
   *  para elegirlas todas de una vez, no solo las de la página. */
  selectableIds: string[];
};

function matchesType(record: ArchiveRecord, filter: ArchiveTypeFilter | undefined): boolean {
  if (filter === "recibidas") return record.type === "PURCHASE";
  if (filter === "emitidas") return record.type === "SALE";
  return true;
}

function matchesMedium(archive: ArchiveRowData, filter: ArchiveMediumFilter | undefined): boolean {
  if (filter === "electronico") return archive.originalMedium === "ELECTRONIC";
  if (filter === "papel") return archive.originalMedium === "PAPER";
  if (filter === "por-confirmar") return archive.originalMedium == null;
  return true;
}

function matchesRegister(archive: ArchiveRowData, register: RegisterQuery): boolean {
  return archive.registerNumber === register.number
    && archive.registerSeries?.year === register.year
    && (register.type == null || archive.registerSeries.type === register.type);
}

const sameAmount = (a: number | null, b: number | null) =>
  a != null && b != null && Math.round(a * 100) === Math.round(b * 100);

/** El texto del filtro de la pestaña: lo que busca el listado de facturas,
 *  más el nº de registro y el importe tal como sale impreso. */
function matchesArchiveQuery(entry: ArchiveEntry, query: ArchiveQuery): boolean {
  if (query.kind === "registro" && matchesRegister(entry.archive, query.register)) return true;
  if (sameAmount(entry.total, query.amount)) return true;
  const { record } = entry;
  return matchesSearch(
    [
      record.invoiceNumber, record.filename, record.issuerName, record.issuerCif, record.receiverName, record.receiverCif,
      entry.registerLabel, ...amountSearchVariants(entry.total),
    ],
    query.text,
  );
}

/**
 * Las facturas del archivo de un cliente cuyo periodo de deducción (el
 * contable y, si no lo hay, el del lote, como invoicePeriod) cae entre dos
 * meses (periodIndex, los dos incluidos), con una etiqueta por periodo. Sin
 * las facturas por clasificar ni las originales divididas; con las
 * rechazadas. Sin ordenar.
 */
async function archiveEntriesBetween(clientId: string, from: number, to: number): Promise<ArchiveEntry[]> {
  const idRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT i."id" FROM "Invoice" i
    WHERE i."clientId" = ${clientId}
      AND i."status"::text NOT IN (${Prisma.join(ARCHIVE_EXCLUDED_STATUSES)})
      AND COALESCE(i."accountingPeriodYear", i."periodYear") * 12
        + COALESCE(i."accountingPeriodMonth", i."periodMonth") - 1 BETWEEN ${from} AND ${to}`;
  return withPeriodGroupLabels((await findArchiveRecords(idRows.map((row) => row.id))).map(toEntry));
}

/**
 * Todo el archivo de un cliente en un ejercicio, o en un trimestre del
 * ejercicio (1 a 4, contando desde su primer mes), en el orden del archivo y
 * sin paginar: lo que lleva el ZIP del ejercicio. Con las rechazadas (quien
 * llama decide). null si el cliente no es de la asesoría (o es el buzón).
 */
export async function loadArchiveYearRows(input: {
  firmId: string;
  clientId: string;
  /** Año en que empieza el ejercicio. */
  fiscalYear: number;
  quarter?: number | null;
}): Promise<{ client: ClientArchive["client"]; fiscalYear: FiscalYear; rows: ClientArchiveRow[] } | null> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, advisoryFirmId: input.firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true, cif: true, fiscalYearStartMonth: true },
  });
  if (!client) return null;
  const startMonth = client.fiscalYearStartMonth;
  const fiscalYear = fiscalYearOf(input.fiscalYear, startMonth, startMonth);
  const [yearFrom, yearTo] = fiscalYearRange(fiscalYear.startYear, startMonth);
  const [from, to] = input.quarter ? [yearFrom + 3 * (input.quarter - 1), yearFrom + 3 * input.quarter - 1] : [yearFrom, yearTo];
  const entries = (await archiveEntriesBetween(client.id, from, to)).sort((a, b) => compareArchiveOrder(a.order, b.order));
  return { client, fiscalYear, rows: await archiveRows(entries, startMonth, input.firmId) };
}

/**
 * El archivo de un cliente en un ejercicio (por defecto, el más reciente con
 * facturas): sin el buzón, sin las facturas por clasificar ni las originales
 * divididas (sí sus partes), y las rechazadas solo si se piden. En el orden
 * del archivo, filtrado y paginado; con las cifras de todo el ejercicio.
 * null si el cliente no es de la asesoría (o es el buzón).
 */
export async function loadClientArchive(input: {
  firmId: string;
  clientId: string;
  /** Año en que empieza el ejercicio. */
  fiscalYear?: number | null;
  filters?: ClientArchiveFilters;
  page?: number;
  pageSize?: number;
  /** Cuántas de lo filtrado se pueden elegir a la vez (las acciones en bloque admiten 200). */
  selectionLimit?: number;
}): Promise<ClientArchive | null> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, advisoryFirmId: input.firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true, cif: true, fiscalYearStartMonth: true },
  });
  if (!client) return null;
  const startMonth = client.fiscalYearStartMonth;

  const fiscalYears = await archiveFiscalYears(client.id, startMonth);
  const today = new Date();
  const fiscalYear = input.fiscalYear != null
    ? fiscalYearOf(input.fiscalYear, startMonth, startMonth)
    : fiscalYears[0] ?? fiscalYearOf(today.getUTCFullYear(), today.getUTCMonth() + 1, startMonth);

  // Las etiquetas, con todo el ejercicio: el subtítulo no cambia con los filtros.
  const [from, to] = fiscalYearRange(fiscalYear.startYear, startMonth);
  const entries = await archiveEntriesBetween(client.id, from, to);

  const summary = emptyArchiveCell();
  for (const entry of entries) addToArchiveCell(summary, metricsRowOf(entry), startMonth);

  const filters = input.filters ?? {};
  const query = parseArchiveQuery(filters.q);
  const visible = entries
    .filter((entry) =>
      (filters.includeRejected || entry.record.status !== "REJECTED")
      && matchesType(entry.record, filters.type)
      && matchesMedium(entry.archive, filters.medium)
      && (!normalizeSearch(query.text) || matchesArchiveQuery(entry, query)))
    .sort((a, b) => compareArchiveOrder(a.order, b.order));

  const groups = new Map<string, ArchivePeriodGroup>();
  for (const entry of visible) {
    const group = groups.get(entry.periodKey);
    if (group) group.count++;
    else groups.set(entry.periodKey, { key: entry.periodKey, label: entry.periodLabel, count: 1 });
  }

  const window = pageWindow(input.page ?? 1, visible.length, input.pageSize ?? PAGE_SIZE);
  const pageEntries = visible.slice(window.skip, window.skip + window.take);
  const rows = await archiveRows(pageEntries, startMonth, input.firmId);

  return {
    client,
    fiscalYears,
    fiscalYear,
    summary,
    periods: [...groups.values()],
    rows,
    window,
    selectableIds: visible.slice(0, input.selectionLimit ?? 0).map((entry) => entry.record.id),
  };
}

const ARCHIVE_DOCUMENT_SELECT = {
  id: true,
  filename: true,
  fileType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.DocumentSelect;

type ArchiveDocument = Prisma.DocumentGetPayload<{ select: typeof ARCHIVE_DOCUMENT_SELECT }>;

/** Lo que una parte toma de la raíz de su división. */
type SplitRootArchive = {
  medium: OriginalMedium | null;
  mediumReason: string | null;
  document: ArchiveDocument | null;
};

/**
 * La fila de archivo de cada raíz de división (por id de la raíz), dentro de
 * la asesoría: su original en otro formato y su medio. Son los de toda la
 * familia: una parte sin adjunto propio tiene el de su raíz, como su medio
 * (writeAutoMedium).
 */
async function splitRootArchives(rootIds: readonly string[], firmId: string): Promise<Map<string, SplitRootArchive>> {
  if (rootIds.length === 0) return new Map();
  const rows = await prisma.invoiceArchive.findMany({
    where: { invoiceId: { in: [...rootIds] }, invoice: { client: { advisoryFirmId: firmId } } },
    select: { invoiceId: true, originalMedium: true, originalMediumReason: true, originalDocument: { select: ARCHIVE_DOCUMENT_SELECT } },
  });
  return new Map(rows.map((row) => [row.invoiceId, {
    medium: row.originalMedium,
    mediumReason: row.originalMediumReason,
    document: row.originalDocument,
  }]));
}

/** El motivo del medio que se enseña. En una parte que va «igual que el
 *  documento dividido», el de su raíz, si la raíz sigue con el mismo medio. */
function mediumReasonLabelOf(
  archive: { originalMedium: OriginalMedium | null; originalMediumReason: string | null },
  root: SplitRootArchive | undefined,
): string | null {
  const rootReason = root && root.medium === archive.originalMedium ? root.mediumReason : null;
  return splitPartReasonLabel(archive.originalMediumReason, rootReason);
}

/** Las filas que se enseñan, con lo que solo hace falta en ellas: avisos,
 *  «Parte 2 de 3» y el original en otro formato (el suyo o el de su raíz). */
async function archiveRows(
  entries: readonly ArchiveEntry[],
  fiscalYearStartMonth: number,
  firmId: string,
): Promise<ClientArchiveRow[]> {
  const seriesIds = [...new Set(entries.map((e) => e.archive.registerSeriesId).filter((id): id is string => id != null))];
  const documentIds = [...new Set(entries.map((e) => e.archive.originalDocumentId).filter((id): id is string => id != null))];
  const [late, families, documents] = await Promise.all([
    lateRegistrations(seriesIds),
    splitFamilies(entries.filter((e) => e.record.splitFromId).map((e) => e.record.id)),
    documentIds.length > 0
      ? prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, filename: true, fileType: true } })
      : Promise.resolve([]),
  ]);
  const documentById = new Map(documents.map((d) => [d.id, d]));
  const rootIds = entries.map((e) => families.get(e.record.id)?.rootId).filter((id): id is string => id != null);
  const roots = await splitRootArchives([...new Set(rootIds)], firmId);

  return entries.map((entry) => {
    const { record, archive } = entry;
    const split = families.get(record.id) ?? null;
    const warnings: ArchiveRowWarning[] = archiveWarnings(
      { ...entry.order, registerSeries: archive.registerSeries },
      { lateRegistration: late.has(record.id) },
    );
    if (split) warnings.push({ code: "split_part", label: `Parte ${split.index} de ${split.count}` });
    const party = thirdParty(record);
    const root = split ? roots.get(split.rootId) : undefined;
    const document = archive.originalDocumentId ? documentById.get(archive.originalDocumentId) : root?.document;
    return {
      invoiceId: record.id,
      status: record.status,
      type: record.type,
      typeUnconfirmed: record.typeUnconfirmed,
      periodKey: entry.periodKey,
      periodLabel: entry.periodLabel,
      invoiceNumber: record.invoiceNumber,
      invoiceDate: record.invoiceDate,
      totalAmount: entry.total,
      currency: record.currency,
      thirdPartyName: party.name,
      thirdPartyCif: party.cif,
      receivedAt: archive.receivedAt,
      registerNumber: entry.registerLabel,
      registeredAt: archive.registeredAt,
      medium: archive.originalMedium,
      mediumSource: archive.originalMediumSource,
      mediumReason: archive.originalMediumReason,
      mediumReasonLabel: mediumReasonLabelOf(archive, root),
      paperHeldByClient: archive.paperHeldByClient,
      retentionHold: archive.retentionHold,
      retentionHoldReason: archive.retentionHoldReason,
      retainUntil: retainUntil({ ...entry.order, retentionHold: archive.retentionHold }, fiscalYearStartMonth),
      rejectionReason: record.rejectionReason,
      originalDocument: document ? { filename: document.filename, fileType: document.fileType } : null,
      split,
      warnings,
    };
  });
}

// ── Ficha de archivo de una factura ─────────────────────────────────────────

/** Campos de la auditoría que cuentan la historia de la factura en el archivo. */
export const ARCHIVE_AUDIT_FIELDS = [
  "registerNumber",
  "originalMedium",
  "auto:originalMedium",
  "retentionHold",
  "originalDocument",
  "paperLocation",
  "archiveExport",
] as const;

export type ArchiveInvoiceDetail = {
  row: ClientArchiveRow;
  client: { id: string; name: string; cif: string; fiscalYearStartMonth: number; isUnclassifiedBucket: boolean };
  fiscalYear: FiscalYear;
  fileType: string;
  filename: string;
  pdfProducer: string | null;
  uploadPosition: number | null;
  splitPart: number;
  retentionHoldNote: string | null;
  /** Lo que se sugiere marcar en «conservar más» (compras con cuenta 2xx). */
  suggestedRetentionHold: RetentionHoldReason | null;
  /** El original en otro formato: el suyo o, en una parte de una división,
   *  el de su raíz (fromSplitRoot), que es el de toda la familia. */
  originalDocument: (ArchiveDocument & { fromSplitRoot: boolean }) | null;
  /** El documento entero, si es una parte de una división. */
  splitRoot: { id: string; filename: string; fileType: string } | null;
  history: { id: string; field: string; oldValue: string | null; newValue: string | null; createdAt: Date; userName: string }[];
};

/** Todo lo de una factura en el archivo, o null si no es de la asesoría. */
export async function loadArchiveInvoice(invoiceId: string, firmId: string): Promise<ArchiveInvoiceDetail | null> {
  const found = await prisma.invoice.findFirst({
    where: { id: invoiceId, client: { advisoryFirmId: firmId } },
    select: {
      ...ARCHIVE_ROW_SELECT,
      fileType: true,
      expenseAccount: true,
      client: { select: { id: true, name: true, cif: true, fiscalYearStartMonth: true, isUnclassifiedBucket: true } },
    },
  });
  if (!found) return null;
  const { client, fileType, expenseAccount, ...record } = found;
  const entry = toEntry(record);
  const [[row], extra, rootId, history] = await Promise.all([
    archiveRows([entry], client.fiscalYearStartMonth, firmId),
    prisma.invoiceArchive.findUnique({
      where: { invoiceId },
      select: { pdfProducer: true, retentionHoldNote: true, originalDocument: { select: ARCHIVE_DOCUMENT_SELECT } },
    }),
    record.splitFromId ? splitRootOf(invoiceId) : Promise.resolve(null),
    prisma.auditLog.findMany({
      where: { invoiceId, field: { in: [...ARCHIVE_AUDIT_FIELDS] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, field: true, oldValue: true, newValue: true, createdAt: true, user: { select: { name: true } } },
    }),
  ]);
  const [splitRoot, rootDocument] = rootId
    ? await Promise.all([
      prisma.invoice.findFirst({
        where: { id: rootId, client: { advisoryFirmId: firmId } },
        select: { id: true, filename: true, fileType: true },
      }),
      extra?.originalDocument ? null : splitRootArchives([rootId], firmId).then((roots) => roots.get(rootId)?.document ?? null),
    ])
    : [null, null];
  const ownDocument = extra?.originalDocument ?? null;
  return {
    row,
    client,
    fiscalYear: archiveFiscalYearOf(record, client.fiscalYearStartMonth),
    fileType,
    filename: record.filename,
    pdfProducer: extra?.pdfProducer ?? null,
    uploadPosition: entry.archive.uploadPosition,
    splitPart: entry.archive.splitPart,
    retentionHoldNote: extra?.retentionHoldNote ?? null,
    suggestedRetentionHold: suggestRetentionHold({ type: record.type, expenseAccount }),
    originalDocument: ownDocument
      ? { ...ownDocument, fromSplitRoot: false }
      : rootDocument ? { ...rootDocument, fromSplitRoot: true } : null,
    splitRoot,
    history: history.map((h) => ({
      id: h.id,
      field: h.field,
      oldValue: h.oldValue,
      newValue: h.newValue,
      createdAt: h.createdAt,
      userName: h.user.name,
    })),
  };
}

// ── El original de verdad ───────────────────────────────────────────────────

export type ArchiveFile = {
  storageKey: string;
  fileType: string;
  filename: string;
  /** other_format: el Word, Excel… adjunto; split_root: el documento entero
   *  del que sale una parte; own: el fichero de la propia factura. */
  kind: "other_format" | "split_root" | "own";
};

/**
 * Qué fichero es el original de una factura: el adjunto en otro formato si lo
 * hay (el suyo o, en una parte de una división, el de su raíz, que es el de
 * toda la familia); si no, el documento entero si es una parte; si no, el
 * suyo. Con `copy`, el que lee la app (el suyo). null si la factura no es de
 * la asesoría.
 */
export async function archiveOriginalFile(
  invoiceId: string,
  firmId: string,
  options: { copy?: boolean } = {},
): Promise<ArchiveFile | null> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, client: { advisoryFirmId: firmId } },
    select: {
      storageKey: true,
      fileType: true,
      filename: true,
      splitFromId: true,
      archive: { select: { originalDocument: { select: { storageKey: true, fileType: true, filename: true } } } },
    },
  });
  if (!invoice) return null;
  const own: ArchiveFile = { storageKey: invoice.storageKey, fileType: invoice.fileType, filename: invoice.filename, kind: "own" };
  if (options.copy) return own;
  const document = invoice.archive?.originalDocument;
  if (document) return { ...document, kind: "other_format" };
  if (invoice.splitFromId) {
    const rootId = await splitRootOf(invoiceId);
    const root = rootId
      ? await prisma.invoice.findFirst({
        where: { id: rootId, client: { advisoryFirmId: firmId } },
        select: {
          storageKey: true,
          fileType: true,
          filename: true,
          archive: { select: { originalDocument: { select: { storageKey: true, fileType: true, filename: true } } } },
        },
      })
      : null;
    if (root?.archive?.originalDocument) return { ...root.archive.originalDocument, kind: "other_format" };
    if (root) return { storageKey: root.storageKey, fileType: root.fileType, filename: root.filename, kind: "split_root" };
  }
  return own;
}

// ── Buscador «¿Dónde está?» ─────────────────────────────────────────────────

/** Por qué sale un resultado. Las cuatro primeras son coincidencias exactas. */
export type ArchiveMatch = "registro" | "importe" | "numero" | "nif" | "texto";

export const ARCHIVE_MATCH_LABELS: Record<ArchiveMatch, string> = {
  registro: "Nº de registro",
  importe: "Importe",
  numero: "Nº de factura",
  nif: "NIF",
  texto: "Texto",
};

export const ARCHIVE_SEARCH_LIMIT = 50;

export type ArchiveSearchResult = {
  invoiceId: string;
  clientId: string;
  clientName: string;
  status: InvoiceStatus;
  type: InvoiceType;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  totalAmount: number | null;
  thirdPartyName: string | null;
  thirdPartyCif: string | null;
  periodLabel: string;
  fiscalYearLabel: string;
  registerNumber: string | null;
  medium: OriginalMedium | null;
  mediumReasonLabel: string | null;
  paperHeldByClient: boolean;
  retainUntil: Date | null;
  matchedBy: ArchiveMatch[];
  /** Casa de forma exacta (nº de registro, importe, nº de factura o NIF):
   *  estas van primero. */
  exact: boolean;
};

/** Sin espacios ni separadores y en mayúsculas, para comparar un nº o un NIF. */
const compactUpper = (value: string, separators: RegExp) => value.replace(separators, "").toUpperCase();

/**
 * Busca en el archivo de la asesoría (o en los clientes del gestor). La
 * consulta se interpreta (nº de registro, importe), pero el texto se busca
 * siempre además: «2026/153» también es un nº de factura de proveedor, y
 * «R-2026/153» existe en cada cliente. Van primero las coincidencias exactas
 * y después las de texto, de la más reciente a la más antigua; como mucho
 * ARCHIVE_SEARCH_LIMIT.
 */
export async function searchArchive(scope: ArchiveScope, rawQuery: string): Promise<ArchiveSearchResult[]> {
  const query = parseArchiveQuery(rawQuery);
  if (!normalizeSearch(query.text) || scope.clientIds.length === 0) return [];
  const where: Prisma.InvoiceWhereInput = {
    clientId: { in: scope.clientIds },
    client: { advisoryFirmId: scope.firmId, isUnclassifiedBucket: false },
    status: { notIn: ARCHIVE_EXCLUDED_STATUSES },
  };
  const number = compactUpper(query.text, /\s+/g);
  const taxId = compactUpper(query.text, /[\s.-]+/g);
  // Sin ninguna letra ni cifra («-», «.») el NIF compactado queda vacío y
  // casaba, exacto, con toda factura sin NIF: no es ni un nº ni un NIF.
  const looksLikeNumberOrTaxId = /[\p{L}\p{N}]/u.test(query.text);

  const [byRegister, byAmount, byNumberOrTaxId, textIds] = await Promise.all([
    query.kind === "registro"
      ? prisma.invoiceArchive.findMany({
        where: {
          registerNumber: query.register.number,
          registerSeries: { year: query.register.year, ...(query.register.type ? { type: query.register.type } : {}) },
          invoice: where,
        },
        select: { invoiceId: true },
        take: 200,
      })
      : Promise.resolve([]),
    query.amount != null
      ? prisma.invoice.findMany({ where: { AND: [where, { totalAmount: query.amount }] }, select: { id: true }, take: 200 })
      : Promise.resolve([]),
    looksLikeNumberOrTaxId
      ? prisma.$queryRaw<{ id: string; numero: boolean; nif: boolean }[]>`
      SELECT i."id",
        upper(regexp_replace(COALESCE(i."invoiceNumber", ''), '\\s', '', 'g')) = ${number} AS numero,
        (upper(regexp_replace(COALESCE(i."issuerCif", ''), '[\\s.-]', '', 'g')) = ${taxId}
          OR upper(regexp_replace(COALESCE(i."receiverCif", ''), '[\\s.-]', '', 'g')) = ${taxId}) AS nif
      FROM "Invoice" i
      JOIN "Client" c ON c."id" = i."clientId"
      WHERE c."advisoryFirmId" = ${scope.firmId}
        AND c."isUnclassifiedBucket" = false
        AND i."clientId" = ANY(${scope.clientIds}::text[])
        AND i."status"::text NOT IN (${Prisma.join(ARCHIVE_EXCLUDED_STATUSES)})
        AND (upper(regexp_replace(COALESCE(i."invoiceNumber", ''), '\\s', '', 'g')) = ${number}
          OR upper(regexp_replace(COALESCE(i."issuerCif", ''), '[\\s.-]', '', 'g')) = ${taxId}
          OR upper(regexp_replace(COALESCE(i."receiverCif", ''), '[\\s.-]', '', 'g')) = ${taxId})
      LIMIT 500`
      : Promise.resolve([]),
    matchingInvoiceIds(where, query.text),
  ]);

  const registerSet = new Set(byRegister.map((r) => r.invoiceId));
  const amountSet = new Set(byAmount.map((r) => r.id));
  const numberSet = new Set(byNumberOrTaxId.filter((r) => r.numero).map((r) => r.id));
  const taxIdSet = new Set(byNumberOrTaxId.filter((r) => r.nif).map((r) => r.id));
  const textSet = new Set(textIds ?? []);
  const exactSet = new Set([...registerSet, ...amountSet, ...numberSet, ...taxIdSet]);

  const orderBy: Prisma.InvoiceOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "asc" }];
  const exactIds = exactSet.size > 0
    ? (await prisma.invoice.findMany({
      where: { AND: [where, { id: { in: [...exactSet] } }] },
      orderBy,
      select: { id: true },
      take: ARCHIVE_SEARCH_LIMIT,
    })).map((r) => r.id)
    : [];
  const textPage = await invoicePageIds({
    where,
    textIds: textIds ?? [],
    orderBy,
    page: 1,
    pageSize: ARCHIVE_SEARCH_LIMIT + exactIds.length,
  });
  const ids = [...exactIds, ...textPage.ids.filter((id) => !exactSet.has(id))].slice(0, ARCHIVE_SEARCH_LIMIT);
  if (ids.length === 0) return [];

  const records = await prisma.invoice.findMany({
    where: { AND: [where, { id: { in: ids } }] },
    select: { ...ARCHIVE_ROW_SELECT, client: { select: { name: true, fiscalYearStartMonth: true } } },
  });
  const families = await splitFamilies(records.filter((record) => record.splitFromId).map((record) => record.id));
  const roots = await splitRootArchives([...new Set([...families.values()].map((family) => family.rootId))], scope.firmId);
  return inIdOrder(records, ids).map(({ client, ...record }) => {
    const entry = toEntry(record);
    const party = thirdParty(record);
    const matchedBy: ArchiveMatch[] = [];
    if (registerSet.has(record.id)) matchedBy.push("registro");
    if (amountSet.has(record.id)) matchedBy.push("importe");
    if (numberSet.has(record.id)) matchedBy.push("numero");
    if (taxIdSet.has(record.id)) matchedBy.push("nif");
    if (textSet.has(record.id)) matchedBy.push("texto");
    return {
      invoiceId: record.id,
      clientId: record.clientId,
      clientName: client.name,
      status: record.status,
      type: record.type,
      invoiceNumber: record.invoiceNumber,
      invoiceDate: record.invoiceDate,
      totalAmount: entry.total,
      thirdPartyName: party.name,
      thirdPartyCif: party.cif,
      periodLabel: entry.periodLabel,
      fiscalYearLabel: archiveFiscalYearOf(record, client.fiscalYearStartMonth).label,
      registerNumber: entry.registerLabel,
      medium: entry.archive.originalMedium,
      mediumReasonLabel: mediumReasonLabelOf(entry.archive, roots.get(families.get(record.id)?.rootId ?? "")),
      paperHeldByClient: entry.archive.paperHeldByClient,
      retainUntil: retainUntil({ ...entry.order, retentionHold: entry.archive.retentionHold }, client.fiscalYearStartMonth),
      matchedBy,
      exact: exactSet.has(record.id),
    };
  });
}

// ── Cifras de la asesoría ───────────────────────────────────────────────────

type MetricsRawRow = {
  clientId: string;
  type: InvoiceType;
  status: InvoiceStatus;
  periodType: PeriodTypeName;
  periodMonth: number;
  periodYear: number;
  accountingPeriodMonth: number | null;
  accountingPeriodYear: number | null;
  medium: OriginalMedium | null;
  registered: boolean;
  retentionHold: boolean;
  lastInvoiceDate: Date | null;
  count: number;
};

/**
 * Las facturas del archivo agrupadas por cliente, periodo, tipo, estado,
 * medio, registro y «conservar más», para buildArchiveMetrics. Siempre dentro
 * de la asesoría y de los clientes del ámbito, sin el buzón, las facturas por
 * clasificar ni las originales divididas.
 */
export async function loadArchiveMetricsRows(scope: ArchiveScope): Promise<ArchiveMetricsRow[]> {
  if (scope.clientIds.length === 0) return [];
  return prisma.$queryRaw<MetricsRawRow[]>`
    SELECT i."clientId",
      i."type"::text AS "type",
      i."status"::text AS "status",
      i."periodType"::text AS "periodType",
      i."periodMonth",
      i."periodYear",
      i."accountingPeriodMonth",
      i."accountingPeriodYear",
      a."originalMedium"::text AS "medium",
      (a."registerNumber" IS NOT NULL) AS "registered",
      COALESCE(a."retentionHold", false) AS "retentionHold",
      MAX(i."invoiceDate") AS "lastInvoiceDate",
      COUNT(*)::int AS "count"
    FROM "Invoice" i
    JOIN "Client" c ON c."id" = i."clientId"
    LEFT JOIN "InvoiceArchive" a ON a."invoiceId" = i."id"
    WHERE c."advisoryFirmId" = ${scope.firmId}
      AND c."isUnclassifiedBucket" = false
      AND i."clientId" = ANY(${scope.clientIds}::text[])
      AND i."status"::text NOT IN (${Prisma.join(ARCHIVE_EXCLUDED_STATUSES)})
    GROUP BY i."clientId", i."type", i."status", i."periodType", i."periodMonth", i."periodYear",
      i."accountingPeriodMonth", i."accountingPeriodYear", a."originalMedium",
      (a."registerNumber" IS NOT NULL), COALESCE(a."retentionHold", false)`;
}

/** Matriz cliente × ejercicio de la asesoría o de los clientes del gestor. */
export async function loadArchiveMetrics(scope: ArchiveScope): Promise<ArchiveMetrics> {
  const [rows, clients] = await Promise.all([
    loadArchiveMetricsRows(scope),
    scope.clientIds.length > 0
      ? prisma.client.findMany({
        where: { id: { in: scope.clientIds }, advisoryFirmId: scope.firmId, isUnclassifiedBucket: false },
        select: { id: true, name: true, fiscalYearStartMonth: true },
        orderBy: { name: "asc" },
      })
      : Promise.resolve([]),
  ]);
  return buildArchiveMetrics(rows, clients);
}
