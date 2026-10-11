/**
 * Ficha de un cliente: las cifras de cabecera y la tabla de periodos. Modulo
 * puro: recibe lo que devuelven los groupBy y lo junta. Las consultas estan
 * en las paginas (admin y gestor comparten estas funciones).
 */
import type { InvoiceStatus, InvoiceType, PeriodType } from "@prisma/client";
import { PENDING_WORK, completionPercent } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";

export type StatusCountRow = { status: InvoiceStatus; count: number };

export type ClientStats = {
  total: number;
  /** Subidas, en analisis, por revisar, con incidencias o en error de OCR. */
  pending: number;
  needsAttention: number;
  ocrError: number;
  /** Validadas que aun no han salido en ningun Excel (o corregidas despues). */
  readyToExport: number;
  /** Salieron alguna vez en un Excel. */
  exported: number;
  rejected: number;
  /** Porcentaje de trabajo terminado (validadas, rechazadas, exportadas). */
  pct: number;
};

/**
 * Las cifras de la cabecera. Las que dependen de la exportacion (salio en un
 * Excel o no) no estan en el estado: vienen contadas aparte.
 */
export function clientStatsFrom(
  rows: StatusCountRow[],
  extra: { exported: number; readyToExport: number },
): ClientStats {
  const byStatus = new Map<InvoiceStatus, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + r.count);
  const count = (s: InvoiceStatus) => byStatus.get(s) ?? 0;
  // El buzon «Sin clasificar» no es de este cliente, y una original dividida
  // no es una factura: ninguna de las dos cuenta.
  const total = [...byStatus.entries()]
    .filter(([s]) => s !== "PENDING_ROUTING" && s !== "SPLIT_SOURCE")
    .reduce((sum, [, n]) => sum + n, 0);
  const validated = count("VALIDATED");
  const rejected = count("REJECTED");
  const exportedStatus = count("EXPORTED");
  return {
    total,
    pending: PENDING_WORK.reduce((sum, s) => sum + count(s), 0),
    needsAttention: count("NEEDS_ATTENTION"),
    ocrError: count("OCR_ERROR"),
    readyToExport: extra.readyToExport,
    exported: extra.exported,
    rejected,
    pct: completionPercent({ total, validated, rejected, exported: exportedStatus }),
  };
}

// ─── Periodos ────────────────────────────────────────────────────────────────

export type PeriodCountRow = {
  periodType: PeriodType;
  periodYear: number;
  periodMonth: number;
  type: InvoiceType;
  status: InvoiceStatus;
  count: number;
};

export type PeriodExportedRow = {
  periodType: PeriodType;
  periodYear: number;
  periodMonth: number;
  count: number;
};

export type ClosureRow = { month: number; year: number; closedAt: Date; reopenedAt: Date | null };

export type PeriodRow = {
  periodType: PeriodType;
  periodYear: number;
  periodMonth: number;
  label: string;
  purchases: number;
  sales: number;
  total: number;
  pending: number;
  validated: number;
  rejected: number;
  /** Salieron en un Excel. */
  exported: number;
  closed: boolean;
  closedAt: Date | null;
};

const periodKey = (periodType: PeriodType, periodYear: number, periodMonth: number) =>
  `${periodType}:${periodYear}:${periodMonth}`;

/**
 * Una fila por periodo con facturas, de la mas reciente a la mas antigua. El
 * cierre solo guarda el mes: un trimestre cerrado es el cierre de su primer
 * mes (closurePeriodType).
 */
export function buildPeriodRows(input: {
  counts: PeriodCountRow[];
  exported: PeriodExportedRow[];
  closures: ClosureRow[];
}): PeriodRow[] {
  const rows = new Map<string, PeriodRow>();
  const rowFor = (periodType: PeriodType, periodYear: number, periodMonth: number): PeriodRow => {
    const key = periodKey(periodType, periodYear, periodMonth);
    let row = rows.get(key);
    if (!row) {
      row = {
        periodType, periodYear, periodMonth,
        label: periodLabel(periodType, periodMonth, periodYear),
        purchases: 0, sales: 0, total: 0, pending: 0, validated: 0, rejected: 0, exported: 0,
        closed: false, closedAt: null,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const c of input.counts) {
    // Las originales divididas no son facturas del periodo.
    if (c.status === "SPLIT_SOURCE" || c.status === "PENDING_ROUTING") continue;
    const row = rowFor(c.periodType, c.periodYear, c.periodMonth);
    row.total += c.count;
    if (c.type === "SALE") row.sales += c.count;
    else row.purchases += c.count;
    if (PENDING_WORK.includes(c.status)) row.pending += c.count;
    if (c.status === "VALIDATED" || c.status === "EXPORTED") row.validated += c.count;
    if (c.status === "REJECTED") row.rejected += c.count;
  }
  for (const e of input.exported) {
    if (!rows.has(periodKey(e.periodType, e.periodYear, e.periodMonth))) continue;
    rowFor(e.periodType, e.periodYear, e.periodMonth).exported += e.count;
  }
  const activeClosures = new Map<string, ClosureRow>();
  for (const cl of input.closures) {
    if (cl.reopenedAt) continue;
    activeClosures.set(`${cl.year}:${cl.month}`, cl);
  }
  for (const row of rows.values()) {
    const closure = activeClosures.get(`${row.periodYear}:${row.periodMonth}`);
    if (closure) {
      row.closed = true;
      row.closedAt = closure.closedAt;
    }
  }
  return [...rows.values()].sort((a, b) =>
    b.periodYear - a.periodYear || b.periodMonth - a.periodMonth || a.periodType.localeCompare(b.periodType),
  );
}

/** Los 12 ultimos periodos con movimiento, para el resumen. */
export const SUMMARY_PERIODS = 12;

// ─── Pestañas ────────────────────────────────────────────────────────────────

export type ClientTab = "resumen" | "facturas" | "periodos" | "exportaciones" | "actividad" | "ajustes";

export const CLIENT_TAB_LABELS: Record<ClientTab, string> = {
  resumen: "Resumen",
  facturas: "Facturas",
  periodos: "Periodos",
  exportaciones: "Exportaciones",
  actividad: "Actividad",
  ajustes: "Ajustes",
};

/** Las del administrador; el gestor no exporta ni cambia la ficha. */
export const ADMIN_CLIENT_TABS: ClientTab[] = ["resumen", "facturas", "periodos", "exportaciones", "actividad", "ajustes"];
export const WORKER_CLIENT_TABS: ClientTab[] = ["resumen", "facturas", "periodos", "actividad"];

export function parseClientTab(raw: string | undefined, allowed: ClientTab[]): ClientTab {
  return allowed.includes(raw as ClientTab) ? (raw as ClientTab) : "resumen";
}

/** Enlace dentro de la ficha: la pestaña y sus parametros, sin los vacios. */
export function clientSheetHref(basePath: string, params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
