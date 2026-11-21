/**
 * Reglas del archivo de facturas que no necesitan base de datos: ejercicio
 * del cliente, «conservar hasta», orden del archivo y avisos de cada fila.
 * Módulo puro (solo tipos de Prisma), para probarlo en el build de Docker.
 */
import type { InvoiceType, RetentionHoldReason } from "@prisma/client";
import { accountGroup } from "@/lib/accountingAccount";
import { parseInvoiceNumber } from "@/lib/invoiceNumbering";
import {
  dateMatchesPeriod,
  hasOwnAccountingPeriod,
  invoicePeriod,
  MONTH_NAMES,
  periodEndMonth,
  periodIndex,
  type InvoicePeriodFields,
  type PeriodTypeName,
} from "@/lib/period";

/** Periodo de una factura: el del lote y, si lo tiene, el contable. */
export type ArchivePeriodFields = InvoicePeriodFields & { periodType: PeriodTypeName };

// ── Ejercicio (R3) ──────────────────────────────────────────────────────────

export type FiscalYear = { startYear: number; label: string };

/** «2026» si el ejercicio es el año natural (empieza en enero); si no,
 *  «2025-26». */
export function fiscalYearLabel(startYear: number, startMonth: number): string {
  if (startMonth === 1) return String(startYear);
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Ejercicio que contiene un mes, con el mes de inicio del cliente. */
export function fiscalYearOf(year: number, month: number, startMonth: number): FiscalYear {
  const startYear = month >= startMonth ? year : year - 1;
  return { startYear, label: fiscalYearLabel(startYear, startMonth) };
}

/** Primer y último mes del ejercicio, en periodIndex (ambos incluidos). */
export function fiscalYearRange(startYear: number, startMonth: number): [number, number] {
  const from = periodIndex(startYear, startMonth);
  return [from, from + 11];
}

/** Último día del ejercicio, a las 00:00 UTC como el resto de fechas de
 *  calendario (formatDateEs). */
export function fiscalYearEnd(startYear: number, startMonth: number): Date {
  const last = fiscalYearRange(startYear, startMonth)[1];
  // El día 0 del mes siguiente es el último del mes: sale el 29 de febrero
  // en los bisiestos.
  return new Date(Date.UTC(Math.floor(last / 12), (last % 12) + 1, 0));
}

/** Trimestre de un ejercicio (1 a 4, contando desde su primer mes):
 *  «T1 (Enero – Marzo 2026)»; si cruza el año, «T1 (Noviembre 2025 – Enero 2026)». */
export function fiscalQuarterLabel(startYear: number, startMonth: number, quarter: number): string {
  const first = periodIndex(startYear, startMonth) + 3 * (quarter - 1);
  const last = first + 2;
  const month = (index: number) => MONTH_NAMES[index % 12];
  const year = (index: number) => Math.floor(index / 12);
  return year(first) === year(last)
    ? `T${quarter} (${month(first)} – ${month(last)} ${year(last)})`
    : `T${quarter} (${month(first)} ${year(first)} – ${month(last)} ${year(last)})`;
}

// ── Conservar hasta (R12) ───────────────────────────────────────────────────

/** Años que hay que conservar desde el cierre del ejercicio (CCom art. 30). */
export const RETENTION_MIN_YEARS = 6;

/**
 * «Conservar hasta»: último día del ejercicio que contiene lo más tardío
 * entre el final del periodo de deducción y la fecha de la factura, más
 * RETENTION_MIN_YEARS años. Con «conservar más», null: sin fecha.
 */
export function retainUntil(
  row: ArchivePeriodFields & { invoiceDate: Date | null; retentionHold?: boolean },
  fiscalYearStartMonth: number,
): Date | null {
  if (row.retentionHold) return null;
  const end = periodEndMonth(row);
  let latest = periodIndex(end.year, end.month);
  const date = row.invoiceDate;
  if (date && !Number.isNaN(date.getTime())) {
    latest = Math.max(latest, periodIndex(date.getUTCFullYear(), date.getUTCMonth() + 1));
  }
  const { startYear } = fiscalYearOf(Math.floor(latest / 12), (latest % 12) + 1, fiscalYearStartMonth);
  return fiscalYearEnd(startYear + RETENTION_MIN_YEARS, fiscalYearStartMonth);
}

// ── Orden del archivo (R4) ──────────────────────────────────────────────────

export type ArchiveOrderRow = ArchivePeriodFields & {
  /** Id de la factura. */
  id: string;
  type: InvoiceType;
  receivedAt: Date;
  uploadPosition: number | null;
  splitPart: number;
  createdAt: Date;
  invoiceDate: Date | null;
  invoiceNumber: string | null;
};

const TYPE_ORDER: Record<InvoiceType, number> = { PURCHASE: 0, SALE: 1 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Los vacíos van al final, como ORDER BY … ASC en Postgres. */
function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a == null || b == null) return (a == null ? 1 : 0) - (b == null ? 1 : 0);
  return a - b;
}

function time(date: Date | null): number | null {
  return date ? date.getTime() : null;
}

type InvoiceNumberKey = { rank: number; prefix: string; seq: number; suffix: string; raw: string };

const compactUpper = (value: string) => value.toUpperCase().replace(/\s+/g, "");

/** Clave del nº de factura en orden natural, con el mismo corte que
 *  parseInvoiceNumber: prefijo, correlativo y sufijo. Los que no tienen
 *  ningún dígito van detrás y los vacíos, al final. */
function invoiceNumberKey(raw: string | null): InvoiceNumberKey {
  const text = (raw ?? "").trim();
  if (!text) return { rank: 2, prefix: "", seq: 0, suffix: "", raw: "" };
  const parsed = parseInvoiceNumber(text);
  if (!parsed) return { rank: 1, prefix: compactUpper(text), seq: 0, suffix: "", raw: text };
  return { rank: 0, prefix: compactUpper(parsed.prefix), seq: parsed.seq, suffix: compactUpper(parsed.suffix), raw: text };
}

/** Nº de factura en orden natural: «F-2» antes que «F-10». */
export function compareInvoiceNumbers(a: string | null, b: string | null): number {
  const ka = invoiceNumberKey(a);
  const kb = invoiceNumberKey(b);
  return (
    ka.rank - kb.rank ||
    compareText(ka.prefix, kb.prefix) ||
    ka.seq - kb.seq ||
    compareText(ka.suffix, kb.suffix) ||
    compareText(ka.raw, kb.raw)
  );
}

/**
 * Orden del archivo, el mismo en la lista, el índice del ZIP y la numeración:
 * periodo de deducción (su primer mes) y, dentro, las recibidas antes que las
 * emitidas. Las recibidas, por llegada, posición en la tanda, parte de la
 * división y alta; las emitidas, por fecha y nº de factura en orden natural, y
 * después por llegada. El id desempata siempre.
 */
export function compareArchiveOrder(a: ArchiveOrderRow, b: ArchiveOrderRow): number {
  const periodA = invoicePeriod(a);
  const periodB = invoicePeriod(b);
  const byPeriod = periodIndex(periodA.year, periodA.month) - periodIndex(periodB.year, periodB.month);
  if (byPeriod !== 0) return byPeriod;
  const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
  if (byType !== 0) return byType;
  const withinType = a.type === "SALE"
    ? compareNullableNumbers(time(a.invoiceDate), time(b.invoiceDate)) ||
      compareInvoiceNumbers(a.invoiceNumber, b.invoiceNumber) ||
      a.receivedAt.getTime() - b.receivedAt.getTime()
    : a.receivedAt.getTime() - b.receivedAt.getTime() ||
      compareNullableNumbers(a.uploadPosition, b.uploadPosition) ||
      a.splitPart - b.splitPart ||
      a.createdAt.getTime() - b.createdAt.getTime();
  return withinType || compareText(a.id, b.id);
}

// ── Registrada tarde y avisos (R8) ──────────────────────────────────────────

export type RegisteredRow = InvoicePeriodFields & {
  id: string;
  registerSeriesId: string | null;
  registerNumber: number | null;
};

/**
 * Facturas registradas tarde: dentro de su serie, con un número mayor que el
 * de alguna factura de un periodo posterior. Se recorre cada serie del
 * periodo más reciente al más antiguo guardando el número más bajo visto.
 * Las que no tienen número no cuentan.
 */
export function flagLateRegistrations(rows: readonly RegisteredRow[]): Set<string> {
  const bySeries = new Map<string, { id: string; number: number; period: number }[]>();
  for (const row of rows) {
    if (row.registerSeriesId == null || row.registerNumber == null) continue;
    const { year, month } = invoicePeriod(row);
    const list = bySeries.get(row.registerSeriesId) ?? [];
    list.push({ id: row.id, number: row.registerNumber, period: periodIndex(year, month) });
    bySeries.set(row.registerSeriesId, list);
  }

  const late = new Set<string>();
  for (const list of bySeries.values()) {
    list.sort((a, b) => b.period - a.period);
    let lowestLater = Infinity;
    let start = 0;
    while (start < list.length) {
      let end = start;
      let lowestHere = Infinity;
      while (end < list.length && list[end].period === list[start].period) {
        if (list[end].number > lowestLater) late.add(list[end].id);
        lowestHere = Math.min(lowestHere, list[end].number);
        end++;
      }
      lowestLater = Math.min(lowestLater, lowestHere);
      start = end;
    }
  }
  return late;
}

export type ArchiveWarningCode =
  | "late_registration"
  | "date_other_period"
  | "numbered_as_other_type"
  | "number_other_year";

export type ArchiveWarning = { code: ArchiveWarningCode; label: string };

export type ArchiveWarningRow = ArchivePeriodFields & {
  type: InvoiceType;
  invoiceDate: Date | null;
  /** Serie del nº de registro; null si aún no lo tiene. */
  registerSeries: { type: InvoiceType; year: number } | null;
};

/**
 * Avisos de una fila del archivo. El nº de registro no cambia nunca: si
 * después se corrige el tipo o el periodo, se avisa. «Registrada tarde» sale
 * de flagLateRegistrations, que necesita la serie entera.
 */
export function archiveWarnings(
  row: ArchiveWarningRow,
  options: { lateRegistration?: boolean } = {},
): ArchiveWarning[] {
  const warnings: ArchiveWarning[] = [];
  if (options.lateRegistration) warnings.push({ code: "late_registration", label: "Registrada tarde" });

  const period = invoicePeriod(row);
  if (row.invoiceDate) {
    const matches = hasOwnAccountingPeriod(row)
      ? dateMatchesPeriod(row.invoiceDate, "MONTHLY", period.month, period.year)
      : dateMatchesPeriod(row.invoiceDate, row.periodType, row.periodMonth, row.periodYear);
    if (!matches) warnings.push({ code: "date_other_period", label: "Fecha de otro periodo" });
  }

  if (row.registerSeries) {
    if (row.registerSeries.type !== row.type) {
      warnings.push({
        code: "numbered_as_other_type",
        label: row.registerSeries.type === "PURCHASE" ? "Numerada como recibida" : "Numerada como emitida",
      });
    }
    if (row.registerSeries.year !== period.year) {
      warnings.push({ code: "number_other_year", label: "Nº de otro año" });
    }
  }
  return warnings;
}

// ── Conservar más (R12) ─────────────────────────────────────────────────────

/** Una compra con cuenta del grupo 2 (inmovilizado) se conserva mientras se
 *  amortiza: se sugiere «Inmovilizado», pero no se marca sola. */
export function suggestRetentionHold(invoice: {
  type: InvoiceType;
  expenseAccount: string | null;
}): RetentionHoldReason | null {
  if (invoice.type !== "PURCHASE" || !invoice.expenseAccount) return null;
  const group = accountGroup(invoice.expenseAccount);
  return group != null && group >= 200 && group <= 299 ? "FIXED_ASSET" : null;
}
