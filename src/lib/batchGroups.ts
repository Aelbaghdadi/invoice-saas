import type { InvoiceStatus, InvoiceType, PeriodType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { QUEUE_ORDER } from "@/lib/reviewQueue";
import { isBatchRejectable, PENDING_WORK } from "@/lib/invoiceStatuses";
import { yearMonthInMadrid } from "@/lib/dates";
import { isPeriodClosed, periodSpan, type ClosedPeriod, type OpenBatch } from "@/lib/batchTarget";

/**
 * Datos de la pantalla de Lotes (gestor y admin), sin cargar el historico
 * entero (F-030). Antes se leian todas las facturas de la asesoria, con su
 * cliente, sus incidencias y sus lotes de exportacion, en cada carga (y cada
 * 5 s con OCR en marcha). Con mas de 65.535 facturas, el include de
 * exportBatchItems pasaba el limite de parametros de Postgres y la pagina
 * fallaba.
 */

/** Meses que se ven por defecto, el actual incluido. */
export const BATCH_WINDOW_MONTHS = 12;

// Postgres admite 65.535 parametros por consulta: las ids van por tandas.
const CHUNK = 10_000;

/** Una factura del lote, con solo lo que la pantalla pinta. */
export type BatchInvoiceRow = {
  id: string;
  clientId: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  type: InvoiceType;
  status: InvoiceStatus;
  exportBatchId: string | null;
  hasOpenIssue: boolean;
  /** Salio alguna vez en un Excel (el historial, no el puntero). */
  everExported: boolean;
};

export type BatchGroup = {
  clientId: string;
  clientName: string;
  clientCif: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  type: InvoiceType;
  total: number;
  // Buckets operativos (los de reviewQueue.ts):
  attentionCount: number; // NEEDS_ATTENTION + OCR_ERROR + PENDING_REVIEW con incidencia abierta
  cleanCount: number; // PENDING_REVIEW sin incidencias
  processingCount: number; // UPLOADED + ANALYZING + ANALYZED (legacy)
  /** Solo UPLOADED + ANALYZING: lo que el OCR tiene de verdad en marcha. */
  ocrRunning: number;
  validated: number;
  rejected: number;
  exported: number;
  ocrError: number;
  /** Lo que tocaria «Rechazar lote» (isBatchRejectable). */
  rejectable: number;
  rejectableValidated: number;
  /** Primeras del lote en el orden de la cola (QUEUE_ORDER). */
  firstAttentionId: string | null;
  firstCleanId: string | null;
  firstPendingId: string | null;
};

/** El mes de hace BATCH_WINDOW_MONTHS - 1 meses (en Madrid): el primero que se ve. */
export function batchWindowStart(now = new Date()): { year: number; month: number } {
  const { year, month } = yearMonthInMadrid(now);
  const index = year * 12 + (month - 1) - (BATCH_WINDOW_MONTHS - 1);
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Periodos desde el inicio de la ventana (los futuros tambien). */
export function recentPeriodsWhere(now = new Date()): Prisma.InvoiceWhereInput {
  const start = batchWindowStart(now);
  return {
    OR: [
      { periodYear: { gt: start.year } },
      { periodYear: start.year, periodMonth: { gte: start.month } },
    ],
  };
}

/**
 * Tope de periodos viejos sueltos en la ventana. Cada uno es un OR de tres
 * columnas sin indice que Postgres evalua fila a fila (y gasta 3 parametros):
 * por encima, la ventana sale mas cara que no tenerla.
 */
export const MAX_RESCUED_PERIODS = 2_000;

/**
 * Por defecto: los ultimos 12 meses y, de antes, los periodos enteros que
 * todavia piden algo (revision 1 del PR #14, punto 2):
 * - algo pendiente de revisar (PENDING_WORK);
 * - una validada sin lote: por exportar, una reexportada o una bloqueante;
 * - sin cierre activo: terminado pero «por cerrar».
 * Un periodo viejo cerrado y exportado es lo unico que se queda fuera.
 *
 * En una asesoria que no cierra periodos se rescata casi todo (revision 2,
 * punto 1): un cliente con todos sus periodos viejos rescatados va por
 * clientId y, si aun asi quedan mas de MAX_RESCUED_PERIODS sueltos, sin
 * ventana, que es lo mismo que «ver todo el histórico».
 */
export async function batchWindowWhere(base: Prisma.InvoiceWhereInput, now = new Date()): Promise<Prisma.InvoiceWhereInput> {
  const recent = recentPeriodsWhere(now);
  const old: Prisma.InvoiceWhereInput = { AND: [base, { NOT: recent }, { status: { notIn: ["SPLIT_SOURCE", "PENDING_ROUTING"] } }] };
  const [actionable, oldPeriods] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["clientId", "periodYear", "periodMonth"],
      where: { AND: [old, { OR: [{ status: { in: PENDING_WORK } }, { status: "VALIDATED", exportBatchId: null }] }] },
    }),
    prisma.invoice.groupBy({ by: ["clientId", "periodYear", "periodMonth"], where: old }),
  ]);
  const key = (k: { clientId: string; periodYear: number; periodMonth: number }) => `${k.clientId}|${k.periodYear}|${k.periodMonth}`;
  const closures = oldPeriods.length
    ? await prisma.periodClosure.findMany({
        where: { clientId: { in: [...new Set(oldPeriods.map((k) => k.clientId))] }, reopenedAt: null },
        select: { clientId: true, year: true, month: true },
      })
    : [];
  const closed = new Set(closures.map((c) => key({ clientId: c.clientId, periodYear: c.year, periodMonth: c.month })));
  const rescued = new Set(actionable.map(key));
  for (const k of oldPeriods) if (!closed.has(key(k))) rescued.add(key(k));

  // Por cliente: si no se esconde ninguno de sus periodos viejos, entero.
  const byClient = new Map<string, { all: number; rescued: typeof oldPeriods }>();
  for (const k of oldPeriods) {
    const c = byClient.get(k.clientId) ?? { all: 0, rescued: [] };
    c.all++;
    if (rescued.has(key(k))) c.rescued.push(k);
    byClient.set(k.clientId, c);
  }
  const wholeClients: string[] = [];
  const periods: Prisma.InvoiceWhereInput[] = [];
  for (const [clientId, c] of byClient) {
    if (c.rescued.length === c.all) wholeClients.push(clientId);
    else for (const k of c.rescued) periods.push({ clientId, periodYear: k.periodYear, periodMonth: k.periodMonth });
  }
  if (periods.length > MAX_RESCUED_PERIODS) return base;
  return {
    AND: [
      base,
      { OR: [recent, ...(wholeClients.length ? [{ clientId: { in: wholeClients } }] : []), ...periods] },
    ],
  };
}

/** Facturas de los lotes, en el orden de la cola dentro de cada periodo. */
export async function loadBatchRows(where: Prisma.InvoiceWhereInput): Promise<BatchInvoiceRow[]> {
  const rows = await prisma.invoice.findMany({
    where,
    select: {
      id: true, clientId: true, periodType: true, periodMonth: true, periodYear: true,
      type: true, status: true, exportBatchId: true,
    },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, ...QUEUE_ORDER],
  });
  const openIssue = new Set<string>();
  const exported = new Set<string>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [issues, items] = await Promise.all([
      prisma.invoiceIssue.findMany({
        where: { invoiceId: { in: chunk }, status: "OPEN" },
        select: { invoiceId: true },
        distinct: ["invoiceId"],
      }),
      prisma.exportBatchItem.findMany({
        where: { invoiceId: { in: chunk } },
        select: { invoiceId: true },
        distinct: ["invoiceId"],
      }),
    ]);
    for (const r of issues) openIssue.add(r.invoiceId);
    for (const r of items) exported.add(r.invoiceId);
  }
  return rows.map((r) => ({ ...r, hasOpenIssue: openIssue.has(r.id), everExported: exported.has(r.id) }));
}

/**
 * Lo que «Subir facturas» necesita para proponer el lote y no abrir otro:
 * - los lotes abiertos de estos clientes en la ventana (los ultimos
 *   BATCH_WINDOW_MONTHS meses): con algo por revisar o validadas sin
 *   exportar, y sin cierre activo, que en un periodo cerrado no se sube;
 * - la agrupacion (mensual o trimestral) de la ultima subida de cada cliente,
 *   sin contar las rechazadas (una trimestral subida por error);
 * - los periodos con cierre activo de cada cliente desde el inicio de la
 *   ventana: la propuesta se los salta y el formulario avisa si se elige uno.
 * «Sin exportar» es sin puntero a un Excel, como cuenta Lotes lo que se
 * llevaria Exportar: una corregida despues de exportarla vuelve a estarlo.
 */
export async function loadOpenBatches(
  firmId: string | null | undefined,
  clientIds: string[],
  now = new Date(),
): Promise<{
  openBatches: OpenBatch[];
  lastPeriodTypes: Record<string, PeriodType>;
  closedPeriods: Record<string, ClosedPeriod[]>;
}> {
  if (!firmId || clientIds.length === 0) return { openBatches: [], lastPeriodTypes: {}, closedPeriods: {} };
  const scope: Prisma.InvoiceWhereInput = {
    AND: [{ clientId: { in: clientIds }, client: { advisoryFirmId: firmId } }, recentPeriodsWhere(now)],
  };
  const start = batchWindowStart(now);
  const [byStatus, toExport, closures] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["clientId", "periodType", "periodYear", "periodMonth", "type", "status"],
      where: { AND: [scope, { status: { notIn: ["SPLIT_SOURCE", "PENDING_ROUTING", "REJECTED"] } }] },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.invoice.groupBy({
      by: ["clientId", "periodType", "periodYear", "periodMonth", "type"],
      where: { AND: [scope, { status: "VALIDATED", exportBatchId: null }] },
      _count: { _all: true },
    }),
    prisma.periodClosure.findMany({
      where: {
        clientId: { in: clientIds },
        client: { advisoryFirmId: firmId },
        reopenedAt: null,
        OR: [{ year: { gt: start.year } }, { year: start.year, month: { gte: start.month } }],
      },
      select: { clientId: true, month: true, year: true },
    }),
  ]);

  const lots = new Map<string, OpenBatch>();
  const lotOf = (row: { clientId: string; periodType: PeriodType; periodYear: number; periodMonth: number; type: InvoiceType }) => {
    const key = batchKey(row);
    let lot = lots.get(key);
    if (!lot) {
      lot = {
        clientId: row.clientId, periodType: row.periodType, periodMonth: row.periodMonth, periodYear: row.periodYear,
        type: row.type, pending: 0, toExport: 0,
      };
      lots.set(key, lot);
    }
    return lot;
  };
  const latest = new Map<string, { at: Date; periodType: PeriodType }>();
  for (const row of byStatus) {
    if (PENDING_WORK.includes(row.status)) lotOf(row).pending += row._count._all;
    const at = row._max.createdAt;
    const seen = latest.get(row.clientId);
    if (at && (!seen || at > seen.at)) latest.set(row.clientId, { at, periodType: row.periodType });
  }
  for (const row of toExport) lotOf(row).toExport += row._count._all;

  const closedPeriods: Record<string, ClosedPeriod[]> = {};
  for (const c of closures) (closedPeriods[c.clientId] ??= []).push({ month: c.month, year: c.year });
  const openBatches = [...lots.values()]
    .filter((l) => !isPeriodClosed(closedPeriods[l.clientId] ?? [], l))
    .sort((a, b) =>
      periodSpan(b).from - periodSpan(a).from || a.type.localeCompare(b.type) || a.periodType.localeCompare(b.periodType));
  return {
    openBatches,
    lastPeriodTypes: Object.fromEntries([...latest].map(([clientId, v]) => [clientId, v.periodType])),
    closedPeriods,
  };
}

/** Clave de un lote: cliente, periodo, agrupacion y tipo. */
export function batchKey(row: Pick<BatchInvoiceRow, "clientId" | "periodYear" | "periodMonth" | "periodType" | "type">): string {
  return `${row.clientId}-${row.periodYear}-${row.periodMonth}-${row.periodType}-${row.type}`;
}

/**
 * Agrupa por lote. Las filas llegan en el orden de la cola, asi que la
 * primera de cada bucket es la primera que abre la revision.
 */
export function groupBatches(
  rows: BatchInvoiceRow[],
  clients: ReadonlyMap<string, { name: string; cif: string }>,
): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const inv of rows) {
    // La original de una division no es una factura mas: sus hijas ya estan
    // en la lista. Contarla dejaba el lote sin llegar nunca a «Completado».
    if (inv.status === "SPLIT_SOURCE") continue;
    const key = batchKey(inv);
    let g = groups.get(key);
    if (!g) {
      const client = clients.get(inv.clientId);
      g = {
        clientId: inv.clientId,
        clientName: client?.name ?? "—",
        clientCif: client?.cif ?? "",
        periodType: inv.periodType,
        periodMonth: inv.periodMonth,
        periodYear: inv.periodYear,
        type: inv.type,
        total: 0,
        attentionCount: 0,
        cleanCount: 0,
        processingCount: 0,
        ocrRunning: 0,
        validated: 0,
        rejected: 0,
        exported: 0,
        ocrError: 0,
        rejectable: 0,
        rejectableValidated: 0,
        firstAttentionId: null,
        firstCleanId: null,
        firstPendingId: null,
      };
      groups.set(key, g);
    }
    g.total++;
    // Exportar no cambia el estado: «exportada» sale del historial de
    // exportaciones, no del puntero, que se pone a null al corregirla y sigue
    // estando en A3. EXPORTED es legacy.
    const isExported = inv.status === "EXPORTED" || (inv.status === "VALIDATED" && inv.everExported);
    if (isExported) g.exported++;
    else if (inv.status === "VALIDATED") g.validated++;
    else if (inv.status === "REJECTED") g.rejected++;
    else if (inv.status === "NEEDS_ATTENTION" || inv.status === "OCR_ERROR" || (inv.status === "PENDING_REVIEW" && inv.hasOpenIssue)) {
      g.attentionCount++;
      if (inv.status === "OCR_ERROR") g.ocrError++;
      g.firstAttentionId ??= inv.id;
      g.firstPendingId ??= inv.id;
    } else if (inv.status === "PENDING_REVIEW") {
      g.cleanCount++;
      g.firstCleanId ??= inv.id;
      g.firstPendingId ??= inv.id;
    } else {
      // UPLOADED / ANALYZING / ANALYZED
      g.processingCount++;
      if (inv.status === "UPLOADED" || inv.status === "ANALYZING") g.ocrRunning++;
    }
    if (isBatchRejectable({ status: inv.status, exportBatchItems: inv.everExported ? [{ id: "" }] : [] })) {
      g.rejectable++;
      if (inv.status === "VALIDATED") g.rejectableValidated++;
    }
  }
  return Array.from(groups.values());
}
