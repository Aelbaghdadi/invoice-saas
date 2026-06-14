/**
 * Lógica de facturas rectificativas (abonos).
 *
 * Una rectificativa puede venir del documento con los importes en POSITIVO
 * aunque contablemente sea un abono (resta del periodo). Reglas:
 *  - Detección: por texto del OCR ("rectificativa", "nota de crédito",
 *    "factura de abono") o por traer ya algún importe negativo.
 *  - Signo: si la factura es rectificativa y TODOS los importes vienen en
 *    positivo, se pasan a negativo. Si ya trae signos mixtos/negativos
 *    (rectificativa por diferencias), se respetan tal cual — así no se
 *    corrompe una rectificativa por diferencias con líneas que suman y restan.
 *
 * Módulo puro (sin Prisma ni Next): lo consumen `processInvoice` (al detectar
 * la rectificativa tras el OCR) y `parseAndSave` (cuando el gestor marca la
 * casilla en revisión), aplicando la MISMA regla en ambos sitios.
 */

// "rectificativ" cubre rectificativa/rectificativo/rectificativas. Evitamos
// "abono" a secas (aparece como forma de pago "abono en cuenta") y exigimos
// "factura de abono". "nota de credito" es el otro nombre habitual.
const RECTIFICATIVE_RE = /rectificativ|nota de credito|factura de abono/;

/** ¿El texto del OCR menciona que es una rectificativa/abono? Insensible a
 *  mayúsculas y tildes. */
export function textMentionsRectificative(rawText: string | null | undefined): boolean {
  if (!rawText) return false;
  const norm = rawText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return RECTIFICATIVE_RE.test(norm);
}

type Line = { taxBase: number; vatRate: number; vatAmount: number };

export type RectificativeAmounts = {
  lines: Line[];
  taxBase: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  irpfAmount: number | null;
  retentionBase: number | null;
};

/** ¿Hay ya algún importe negativo? (los % de IVA no cuentan, nunca llevan signo). */
function anyNegativeAmount(a: RectificativeAmounts): boolean {
  if (a.lines.some((l) => l.taxBase < 0 || l.vatAmount < 0)) return true;
  return [a.taxBase, a.vatAmount, a.totalAmount, a.irpfAmount, a.retentionBase].some(
    (v) => v != null && v < 0,
  );
}

/**
 * Aplica el signo de abono a una rectificativa. Si vino TODO en positivo,
 * pasa los importes a negativo (−|valor|). Si ya hay signos mixtos/negativos,
 * los respeta. Los tipos (% IVA) nunca cambian de signo.
 */
export function applyRectificativeSign(a: RectificativeAmounts): RectificativeAmounts {
  if (anyNegativeAmount(a)) return a; // signos mixtos / ya-negativos: respetar
  const neg = (v: number | null): number | null => (v == null ? v : -Math.abs(v));
  return {
    lines: a.lines.map((l) => ({
      taxBase: -Math.abs(l.taxBase),
      vatRate: l.vatRate, // el % no cambia de signo
      vatAmount: -Math.abs(l.vatAmount),
    })),
    taxBase: neg(a.taxBase),
    vatAmount: neg(a.vatAmount),
    totalAmount: neg(a.totalAmount),
    irpfAmount: neg(a.irpfAmount),
    retentionBase: neg(a.retentionBase),
  };
}
