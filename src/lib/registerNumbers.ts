/**
 * Nº de registro del archivo (R7): cómo se escribe, cómo se lee lo que teclea
 * el buscador y qué números tocan a las facturas de un lote de exportación.
 * Módulo puro: la reserva del contador en la BD va aparte (archiveRegister).
 */
import type { InvoiceType } from "@prisma/client";
import { compareArchiveOrder, type ArchiveOrderRow } from "@/lib/archiveRules";
import { invoicePeriod } from "@/lib/period";

/** Letra de cada serie: R las recibidas, E las emitidas. */
export const REGISTER_SERIES_LETTERS: Record<InvoiceType, "R" | "E"> = { PURCHASE: "R", SALE: "E" };

/** Una serie es de un cliente, un tipo y un año natural (el del periodo de
 *  deducción). */
export type RegisterSeriesKey = { clientId: string; type: InvoiceType; year: number };

const padNumber = (number: number) => String(number).padStart(4, "0");

/** «R-2026/0153». Con más de 9.999 facturas el número crece: «R-2026/12345». */
export function formatRegisterNumber(series: { type: InvoiceType; year: number }, number: number): string {
  return `${REGISTER_SERIES_LETTERS[series.type]}-${series.year}/${padNumber(number)}`;
}

/** «R-2026-0153»: el nº sin barra, para el nombre de un fichero. */
export function registerFileStem(series: { type: InvoiceType; year: number }, number: number): string {
  return `${REGISTER_SERIES_LETTERS[series.type]}-${series.year}-${padNumber(number)}`;
}

/** Nº de registro tecleado. type null: sin letra, vale para las dos series. */
export type RegisterQuery = { type: InvoiceType | null; year: number; number: number };

const WITH_LETTER_RE = /^([re])\s*-?\s*((?:19|20)\d{2})\s*[/-]\s*(\d{1,9})$/i;
// Sin letra solo con barra: «2026-153» se parece demasiado a un nº de factura.
const WITHOUT_LETTER_RE = /^((?:19|20)\d{2})\s*\/\s*(\d{1,9})$/;

/** Lee «R-2026/153», «r 2026/0153», «E2025/7», «R-2026-0153» (el de los
 *  ficheros) o «2026/153». null si no es un nº de registro. */
export function parseRegisterQuery(raw: string): RegisterQuery | null {
  const text = raw.trim();
  const withLetter = WITH_LETTER_RE.exec(text);
  if (withLetter) {
    return registerQuery(withLetter[1].toUpperCase() === "R" ? "PURCHASE" : "SALE", withLetter[2], withLetter[3]);
  }
  const withoutLetter = WITHOUT_LETTER_RE.exec(text);
  return withoutLetter ? registerQuery(null, withoutLetter[1], withoutLetter[2]) : null;
}

function registerQuery(type: InvoiceType | null, year: string, number: string): RegisterQuery | null {
  const value = Number(number);
  return value > 0 ? { type, year: Number(year), number: value } : null;
}

/** Clave de una serie en los Map: «clientId|PURCHASE|2026». */
export function registerSeriesKey(series: RegisterSeriesKey): string {
  return `${series.clientId}|${series.type}|${series.year}`;
}

/** Orden de las series, que también es el orden en que se bloquean sus
 *  contadores: dos exportaciones a la vez nunca se esperan en cruz. */
function compareSeries(a: RegisterSeriesKey, b: RegisterSeriesKey): number {
  if (a.clientId !== b.clientId) return a.clientId < b.clientId ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.year - b.year;
}

export type RegisterPlanRow = ArchiveOrderRow & {
  clientId: string;
  /** Si ya tiene número, se salta: no cambia nunca. */
  registerNumber: number | null;
};

export type RegisterBlock = RegisterSeriesKey & {
  key: string;
  /** Último número de la serie antes de este bloque. */
  previous: number;
  /** Facturas en el orden del archivo, con su número: previous + 1, + 2… */
  entries: { invoiceId: string; number: number }[];
};

/**
 * Plan de numeración de un lote: agrupa las facturas sin número por serie y,
 * dentro de cada serie, las numera en el orden del archivo a partir del
 * último número (lastBySeries, por registerSeriesKey; 0 si la serie es nueva).
 * Los bloques salen en el orden de sus claves.
 */
export function planRegisterNumbers(
  rows: readonly RegisterPlanRow[],
  lastBySeries: ReadonlyMap<string, number> = new Map(),
): RegisterBlock[] {
  const groups = new Map<string, { series: RegisterSeriesKey; rows: RegisterPlanRow[] }>();
  for (const row of rows) {
    if (row.registerNumber != null) continue;
    const series: RegisterSeriesKey = { clientId: row.clientId, type: row.type, year: invoicePeriod(row).year };
    const key = registerSeriesKey(series);
    const group = groups.get(key) ?? { series, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort(([, a], [, b]) => compareSeries(a.series, b.series))
    .map(([key, group]) => {
      const previous = lastBySeries.get(key) ?? 0;
      const ordered = [...group.rows].sort(compareArchiveOrder);
      return {
        ...group.series,
        key,
        previous,
        entries: ordered.map((row, index) => ({ invoiceId: row.id, number: previous + index + 1 })),
      };
    });
}
