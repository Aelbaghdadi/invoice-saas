import { equivalenceSurchargeRateForVat } from "./validators";

/**
 * Recargo de equivalencia: normalizacion y propuesta.
 *
 * Dos problemas reales que resuelve este modulo:
 *
 * 1) La IA devuelve a veces el recargo como si fuera OTRA linea de IVA, con
 *    el tipo del recargo (5,2 / 1,4 / 0,5), porque en la factura aparece como
 *    una fila mas del cuadro de impuestos ("REC 5,2% ... 14,90"). Caso real:
 *    6 facturas en produccion, unas con base 0 y la cuota en el IVA, otras
 *    con el importe en la base y cuota 0, y dos con el recargo ademas bien
 *    puesto (contado dos veces). Esas lineas se pliegan sobre su linea de IVA.
 *
 * 2) Cuando nadie lee el recargo, calcularlo "a ciegas" (base x %) inventa
 *    recargo donde no lo hay (portes, servicios) y se desvia uno o dos
 *    centimos del impreso, porque el proveedor redondea articulo a articulo.
 *    Aqui solo se propone cuando el recargo EXPLICA la diferencia que le
 *    falta a la factura para llegar a su total.
 */

export type SurchargeLine = {
  taxBase: number;
  vatRate: number;
  vatAmount: number;
  /** null / ausente = esta linea no lleva recargo. NO confundir con 0. */
  equivalenceSurchargeRate?: number | null;
  equivalenceSurchargeAmount?: number | null;
};

/** % de recargo -> % de IVA al que acompaña. El inverso del mapa de validators. */
const VAT_BY_SURCHARGE_RATE: Record<number, number> = { 5.2: 21, 1.4: 10, 0.5: 4 };

/** Tipos de IVA validos en factura española (el 0 incluido: intracom, exentas). */
const VALID_VAT_RATES = new Set([0, 4, 5, 10, 21]);

/** ¿Este "tipo de IVA" es en realidad un tipo de recargo de equivalencia? */
export function isSurchargeRate(rate: number): boolean {
  return rate in VAT_BY_SURCHARGE_RATE;
}

/** ¿Es un tipo de IVA de los que existen en una factura española? */
export function isStandardVatRate(rate: number): boolean {
  return VALID_VAT_RATES.has(rate);
}

const round2 = (n: number) => parseFloat(n.toFixed(2));

/**
 * Pliega sobre su linea de IVA las "lineas" que en realidad son el recargo.
 *
 * El importe del recargo puede venir en la cuota (base 0) o en la base
 * (cuota 0): se coge el que no sea cero. Si la linea de IVA que le
 * corresponde ya traia recargo, la falsa se descarta por duplicada.
 * Si no hay ninguna linea de ese tipo de IVA, la linea se conserva tal cual
 * (`huerfanas`) — mejor que el gestor la vea a que desaparezca dinero.
 */
export function foldSurchargeLines<T extends SurchargeLine>(
  lines: T[],
): { lines: T[]; plegadas: number; huerfanas: number } {
  const result = lines.map((l) => ({ ...l }));
  const keep: boolean[] = result.map(() => true);
  let plegadas = 0;
  let huerfanas = 0;

  result.forEach((line, i) => {
    if (!isSurchargeRate(line.vatRate)) return;
    // Una linea con tipo de recargo que ademas trae recargo propio no es la
    // fila del cuadro de impuestos: se deja como esta (caso rarisimo).
    if (line.equivalenceSurchargeRate != null) return;

    const amount = line.vatAmount !== 0 ? line.vatAmount : line.taxBase;
    const vatRate = VAT_BY_SURCHARGE_RATE[line.vatRate];
    const target = result.find(
      (l, j) => keep[j] && j !== i && l.vatRate === vatRate && !isSurchargeRate(l.vatRate),
    );
    if (!target) {
      huerfanas++;
      return;
    }

    keep[i] = false;
    plegadas++;
    if (target.equivalenceSurchargeAmount != null) {
      // Ya estaba bien puesto: la linea falsa era una copia (se contaba dos veces).
      return;
    }
    target.equivalenceSurchargeRate = line.vatRate;
    target.equivalenceSurchargeAmount = round2(amount);
  });

  return { lines: result.filter((_, i) => keep[i]), plegadas, huerfanas };
}

/**
 * Completa el recargo de una linea cuando la IA leyo solo la mitad: con el %
 * calcula la cuota, y con la cuota deduce el % si encaja con alguno de los
 * tres habituales. Nunca pisa un importe leido del documento.
 */
export function completeReadSurcharges<T extends SurchargeLine>(lines: T[]): T[] {
  return lines.map((l) => {
    const line = { ...l };
    if (line.equivalenceSurchargeRate != null && line.equivalenceSurchargeAmount == null) {
      line.equivalenceSurchargeAmount = round2((line.taxBase * line.equivalenceSurchargeRate) / 100);
    } else if (line.equivalenceSurchargeAmount != null && line.equivalenceSurchargeRate == null) {
      const mapped = equivalenceSurchargeRateForVat(line.vatRate);
      if (mapped != null) line.equivalenceSurchargeRate = mapped;
    }
    return line;
  });
}

export type SurchargeProposal = { index: number; rate: number; amount: number };

/**
 * Propone el recargo SOLO si explica lo que le falta a la factura para
 * cuadrar con su total. Nunca lo reparte "porque el IVA es 21".
 *
 * Se prueban todas las combinaciones de lineas candidatas (las que tienen un
 * tipo con recargo habitual y aun no lo llevan) y se elige la que mas se
 * acerca a la diferencia; si queda un descuadre de uno o dos centimos —el
 * proveedor redondea articulo a articulo y nosotros sobre la base total— se
 * ajusta la linea de mayor importe para que cuadre exacto.
 *
 * Devuelve [] si no hay diferencia que explicar o si ninguna combinacion la
 * explica: en ese caso es mejor no inventar nada.
 */
export function proposeSurchargesFromTotal(
  lines: SurchargeLine[],
  totalAmount: number | null,
  irpfAmount: number | null,
): SurchargeProposal[] {
  if (totalAmount == null || lines.length === 0) return [];

  const already = lines.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0);
  const sBase = lines.reduce((s, l) => s + l.taxBase, 0);
  const sVat = lines.reduce((s, l) => s + l.vatAmount, 0);
  const missing = round2(totalAmount - (sBase + sVat + already - (irpfAmount ?? 0)));
  if (Math.abs(missing) < 0.005) return [];

  const candidates = lines
    .map((l, index) => ({ index, rate: equivalenceSurchargeRateForVat(l.vatRate), taxBase: l.taxBase }))
    .filter((c): c is { index: number; rate: number; taxBase: number } =>
      c.rate != null && lines[c.index].equivalenceSurchargeAmount == null);
  // 2^n combinaciones: con mas de 8 lineas de IVA (jamas visto) no se intenta.
  if (candidates.length === 0 || candidates.length > 8) return [];

  let best: { picked: typeof candidates; diff: number } | null = null;
  for (let mask = 1; mask < (1 << candidates.length); mask++) {
    const picked = candidates.filter((_, i) => mask & (1 << i));
    const sum = picked.reduce((s, c) => s + round2((c.taxBase * c.rate) / 100), 0);
    const diff = Math.abs(round2(sum - missing));
    if (!best || diff < best.diff || (diff === best.diff && picked.length > best.picked.length)) {
      best = { picked, diff };
    }
  }
  if (!best || best.diff > 0.02) return [];

  const proposals = best.picked.map((c) => ({
    index: c.index,
    rate: c.rate,
    amount: round2((c.taxBase * c.rate) / 100),
  }));
  // El ajuste del centimo va a la linea de mayor importe, que es donde menos
  // se nota y donde el proveedor acumula su redondeo.
  const residual = round2(missing - proposals.reduce((s, p) => s + p.amount, 0));
  if (residual !== 0) {
    let biggest = 0;
    proposals.forEach((p, i) => {
      if (Math.abs(p.amount) > Math.abs(proposals[biggest].amount)) biggest = i;
    });
    proposals[biggest] = { ...proposals[biggest], amount: round2(proposals[biggest].amount + residual) };
  }
  return proposals;
}

/** Resumen legible del recargo de una factura, para la auditoria. */
export function surchargeAuditValue(lines: SurchargeLine[]): string | null {
  const conRecargo = lines.filter((l) => l.equivalenceSurchargeAmount != null);
  if (conRecargo.length === 0) return null;
  return conRecargo
    .map((l) => `${l.vatRate}%: ${l.equivalenceSurchargeRate ?? "?"}% ${l.equivalenceSurchargeAmount}`)
    .join(" | ");
}
