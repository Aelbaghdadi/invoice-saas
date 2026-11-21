/** Utilidades para manejar periodos mensuales y trimestrales. */
import { yearMonthInMadrid } from "@/lib/dates";

export type PeriodTypeName = "MONTHLY" | "QUARTERLY";

/** Devuelve el trimestre (1-4) al que pertenece un mes (1-12). */
export function quarterFromMonth(month: number): number {
  return Math.ceil(month / 3);
}

/** Devuelve el primer mes del trimestre dado (Q1→1, Q2→4, Q3→7, Q4→10). */
export function quarterStartMonth(quarter: number): number {
  return (quarter - 1) * 3 + 1;
}

/** Etiqueta legible del trimestre: "T1", "T2", etc. */
export function quarterLabel(quarter: number): string {
  return `T${quarter}`;
}

/** Etiqueta legible del periodo: "Enero 2025" o "T1 2025". */
export function periodLabel(periodType: PeriodTypeName, periodMonth: number, periodYear: number): string {
  if (periodType === "QUARTERLY") {
    const q = quarterFromMonth(periodMonth);
    return `T${q} ${periodYear}`;
  }
  return `${MONTH_NAMES[periodMonth - 1] ?? periodMonth} ${periodYear}`;
}

/**
 * El mes o el trimestre anterior a hoy (en Madrid), con su año. Aquí y no en
 * exportPage, que lo reexporta: el formulario de subida lo usa en el navegador
 * y exportPage arrastraría zod.
 */
export function previousPeriod(periodType: PeriodTypeName, now = new Date()): { month: number; year: number } {
  const { year, month } = yearMonthInMadrid(now);
  if (periodType === "QUARTERLY") {
    const quarter = quarterFromMonth(month);
    return quarter === 1 ? { month: 10, year: year - 1 } : { month: quarterStartMonth(quarter - 1), year };
  }
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

/**
 * Comprueba si una fecha pertenece al periodo indicado.
 * Para MONTHLY: el mes y año deben coincidir exactamente.
 * Para QUARTERLY: el mes debe estar dentro de los 3 meses del trimestre,
 * y el año coincidir.
 */
export function dateMatchesPeriod(
  date: Date,
  periodType: PeriodTypeName,
  periodMonth: number,
  periodYear: number,
): boolean {
  const dateYear  = date.getFullYear();
  const dateMonth = date.getMonth() + 1;
  if (dateYear !== periodYear) return false;
  if (periodType === "MONTHLY") return dateMonth === periodMonth;
  // QUARTERLY: periodMonth es el primer mes del trimestre
  return dateMonth >= periodMonth && dateMonth <= periodMonth + 2;
}

/** Opciones del selector de trimestre para formularios. */
export const QUARTER_OPTIONS = [
  { value: 1, label: "T1 (Enero – Marzo)" },
  { value: 2, label: "T2 (Abril – Junio)" },
  { value: 3, label: "T3 (Julio – Septiembre)" },
  { value: 4, label: "T4 (Octubre – Diciembre)" },
] as const;

/** Nombres de los meses con mayuscula, como se ven en toda la app. */
export const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
] as const;

/** Opciones de mes para los desplegables (valor "1".."12"). Estaba copiada a
 *  mano en siete pantallas, cada una con su forma. */
export const MONTH_OPTIONS = MONTH_NAMES.map((label, i) => ({ value: String(i + 1), label }));
