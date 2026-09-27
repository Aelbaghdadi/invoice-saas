/**
 * Lógica de facturas rectificativas (abonos).
 *
 * Una rectificativa puede venir del documento con los importes en POSITIVO
 * aunque contablemente sea un abono (resta del periodo). Reglas:
 *  - El OCR no cambia signos (F-012): la mencion en el texto daba positivo
 *    con «no es rectificativa» y negaba facturas ordinarias sin marcarlas.
 *    Con la mencion, o con importes negativos, crea una incidencia para que
 *    el gestor lo revise (rectificativeSignHint).
 *  - Signo: si el gestor marca la casilla y TODOS los importes vienen en
 *    positivo, se pasan a negativo. Si ya trae signos mixtos/negativos
 *    (rectificativa por diferencias), se respetan tal cual — así no se
 *    corrompe una rectificativa por diferencias con líneas que suman y restan.
 *
 * Módulo puro (sin Prisma ni Next): lo consumen `processInvoice` (la
 * incidencia tras el OCR) y `parseAndSave` (el signo, cuando el gestor marca
 * la casilla en revisión).
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
    .replace(/[̀-ͯ]/g, "")
    // pdfjs deja dobles espacios: «Factura  de  abono» no casaba.
    .replace(/\s+/g, " ")
    // Las negaciones son justo lo contrario, y con el texto de los PDF ya
    // activo (F-013) salen: «no es rectificativa», «Rectificativa: No»,
    // «Tipo de factura: Ordinaria · Rectificativa: No».
    .replace(/\bno (?:es )?(?:una )?(?:factura )?(?:rectificativ\w*|nota de credito|factura de abono)/g, " ")
    .replace(/(?:rectificativ\w*|nota de credito|factura de abono) ?[:=] ?(?:no|false)\b/g, " ");
  return RECTIFICATIVE_RE.test(norm);
}

/** El recargo de equivalencia va por linea y tiene que cambiar de signo con
 *  ella: un abono con recargo positivo descuadra y llega asi al Excel de A3. */
type Line = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  equivalenceSurchargeRate?: number | null;
  equivalenceSurchargeAmount?: number | null;
};

export type RectificativeAmounts = {
  lines: Line[];
  taxBase: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  irpfAmount: number | null;
  retentionBase: number | null;
};

/** ¿Hay ya algún importe negativo? (los % de IVA no cuentan, nunca llevan signo). */
export function anyNegativeAmount(a: RectificativeAmounts): boolean {
  if (a.lines.some((l) => l.taxBase < 0 || l.vatAmount < 0 || (l.equivalenceSurchargeAmount ?? 0) < 0)) return true;
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
      ...l,
      taxBase: -Math.abs(l.taxBase),
      vatRate: l.vatRate, // el % no cambia de signo
      vatAmount: -Math.abs(l.vatAmount),
      // El % de recargo tampoco cambia de signo; su cuota si.
      equivalenceSurchargeAmount:
        l.equivalenceSurchargeAmount == null ? l.equivalenceSurchargeAmount : -Math.abs(l.equivalenceSurchargeAmount),
    })),
    taxBase: neg(a.taxBase),
    vatAmount: neg(a.vatAmount),
    totalAmount: neg(a.totalAmount),
    irpfAmount: neg(a.irpfAmount),
    retentionBase: neg(a.retentionBase),
  };
}

/**
 * Incidencia del OCR sobre el signo, o null. El OCR no toca los signos: con
 * importes negativos hay que marcar la casilla (si es un abono) o corregirlos;
 * con solo la mencion en el texto, revisar si es un abono que vino en
 * positivo.
 */
export function rectificativeSignHint(
  a: RectificativeAmounts,
  rawText: string | null | undefined,
  /** Ya se sabe que el documento lo menciona (guardado en el buzon). */
  mentioned = false,
): string | null {
  if (anyNegativeAmount(a)) {
    return "La factura trae importes negativos: si es un abono, marca «Es una rectificativa» en la revisión; si no, corrige el signo.";
  }
  if (mentioned || textMentionsRectificative(rawText)) {
    return "Parece rectificativa: revisa el signo. El documento habla de rectificativa, nota de crédito o factura de abono, "
      + "pero los importes vienen en positivo y no se han cambiado.";
  }
  return null;
}

/**
 * La mencion en el texto se guarda en el JSON crudo de la extraccion
 * (rawResponse) cuando la factura queda «Por clasificar»: ahi el OCR no crea
 * incidencias y classifyInvoice ya no tiene el texto. Sin migracion. Un
 * rawResponse que no es un objeto JSON (el XML de Facturae) se deja igual.
 */
export function withRectificativeMention(rawResponse: string): string {
  try {
    const parsed = JSON.parse(rawResponse);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawResponse;
    return JSON.stringify({ ...parsed, rectificativeMention: true });
  } catch {
    return rawResponse;
  }
}

/** ¿El rawResponse guardado lleva la mencion? */
export function hasRectificativeMention(rawResponse: string | null | undefined): boolean {
  if (!rawResponse) return false;
  try {
    return JSON.parse(rawResponse)?.rectificativeMention === true;
  } catch {
    return false;
  }
}
