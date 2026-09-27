/**
 * Importes en centimos. La BD guarda numeric(12,2): lo que llega con mas
 * decimales se redondea al guardar, y un cuadre calculado antes deja de
 * valer (revision 1 del PR #7). Sin dependencias: lo usan el servidor, el
 * OCR y la pantalla.
 */

/** Euros a centimos, redondeando la mitad lejos del cero, como se redondea
 *  en una factura (-12,105 -> -1211, no -1210 como Math.round). El 1e-7
 *  absorbe el ruido de coma flotante: 1,005 * 100 da 100,4999... */
export function toCents(amount: number): number {
  return Math.sign(amount) * Math.round(Math.abs(amount) * 100 + 1e-7);
}

/** base × % redondeado a centimos (la cuota de un tipo, la retencion). */
export function percentCents(base: number, ratePercent: number): number {
  const cents = base * ratePercent; // base × % / 100, ya en centimos
  return Math.sign(cents) * Math.round(Math.abs(cents) + 1e-7);
}

/** base × % en euros, redondeado a centimos. */
export function percentOf(base: number, ratePercent: number): number {
  return percentCents(base, ratePercent) / 100;
}

/** ¿Tiene mas de 2 decimales? 1,005 si; 1,5 y 15,05 no. */
export function hasMoreThanTwoDecimals(amount: number): boolean {
  const cents = amount * 100;
  return Math.abs(cents - Math.round(cents)) > 1e-6;
}
