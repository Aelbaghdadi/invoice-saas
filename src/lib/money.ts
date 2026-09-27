/**
 * Importes en centimos. La BD guarda numeric(12,2): lo que llega con mas
 * decimales se redondea al guardar, y un cuadre calculado antes deja de
 * valer (revision 1 del PR #7). Sin dependencias: lo usan el servidor, el
 * OCR y la pantalla.
 */

/** Margen para el ruido de coma flotante al contar centimos. Relativo al
 *  tamano: uno fijo (1e-7, 1e-6) deja de cubrir el error a partir de unos
 *  134 M€, y 134.218.247,52 salia con «más de 2 decimales». */
function noise(cents: number): number {
  return Math.max(1e-7, Math.abs(cents) * Number.EPSILON * 8);
}

/** Euros a centimos, redondeando la mitad lejos del cero, como se redondea
 *  en una factura (-12,105 -> -1211, no -1210 como Math.round). El margen
 *  absorbe el ruido de coma flotante: 1,005 * 100 da 100,4999... */
export function toCents(amount: number): number {
  const cents = Math.abs(amount) * 100;
  return Math.sign(amount) * Math.round(cents + noise(cents));
}

/** base × % redondeado a centimos (la cuota de un tipo, la retencion). */
export function percentCents(base: number, ratePercent: number): number {
  const cents = base * ratePercent; // base × % / 100, ya en centimos
  return Math.sign(cents) * Math.round(Math.abs(cents) + noise(cents));
}

/** base × % en euros, redondeado a centimos. */
export function percentOf(base: number, ratePercent: number): number {
  return percentCents(base, ratePercent) / 100;
}

/** ¿Tiene mas de 2 decimales? 1,005 si; 1,5 y 15,05 no. */
export function hasMoreThanTwoDecimals(amount: number): boolean {
  const cents = amount * 100;
  return Math.abs(cents - Math.round(cents)) > Math.max(1e-6, Math.abs(cents) * Number.EPSILON * 8);
}

/** Redondeado a centimos (como lo guarda numeric(12,2)), o null. */
export function roundCents(amount: number): number;
export function roundCents(amount: number | null | undefined): number | null;
export function roundCents(amount: number | null | undefined): number | null {
  return amount == null || !Number.isFinite(amount) ? amount ?? null : toCents(amount) / 100;
}
