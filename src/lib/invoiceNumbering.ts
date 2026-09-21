/**
 * Deteccion de huecos en la numeracion de facturas: dentro de un mismo
 * emisor, si los numeros van 1, 2, 4... avisa de que falta el 3.
 *
 * Heuristica de parseo del numero de factura:
 *  - "NNNN/AAAA" (correlativo + separador + año de 4 cifras al final, p.ej.
 *    "EXP-0007/2026"): el correlativo es el 0007 y el año forma parte de la
 *    serie, asi un año nuevo empieza otra secuencia sin dar falsos huecos.
 *  - En cualquier otro caso el correlativo es el ULTIMO tramo de digitos
 *    ("2026-045", "FRA0001", "A/123", "12", "F-2026-Cliente4-0001"); lo de
 *    delante y lo de detras (p.ej. "-R" de una rectificativa en
 *    "SM-2026-0142-R") forman la serie, asi una rectificativa no se mezcla
 *    con las ordinarias.
 * Sin ningun digito no se puede ubicar en una secuencia y se ignora.
 * Cada emisor se compara solo con sus propias facturas, asi que formatos
 * distintos entre proveedores no interfieren.
 */

// Saltos mayores que esto casi seguro son series distintas que han caido en
// el mismo grupo (o un OCR mal leido), no un hueco real que avisar.
const MAX_GAP = 50;

type Parsed = {
  /** Clave de agrupacion: prefijo + sufijo (año) normalizados. */
  series: string;
  seq: number;
  prefix: string;
  suffix: string;
  /** Anchura con ceros a la izquierda ("0007" → 4); 0 si no lleva ceros. */
  width: number;
};

export function parseInvoiceNumber(raw: string): Parsed | null {
  const text = raw.trim();
  const withYear = text.match(/^(.*?)(\d+)(\s*[/\-.]\s*(?:19|20)\d{2})$/);
  const match = withYear ?? text.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return null;
  const [, prefix, digits, suffix] = match;
  return {
    series: `${prefix}\u0000${suffix}`.toUpperCase().replace(/\s+/g, ""),
    seq: parseInt(digits, 10),
    prefix,
    suffix,
    width: digits.length > 1 && digits.startsWith("0") ? digits.length : 0,
  };
}

/** Reconstruye el numero de factura de un correlativo con el mismo formato
 *  que otro de su serie ("EXP-0006/2026" a partir de "EXP-0007/2026"). */
function formatLike(p: Parsed, seq: number): string {
  return `${p.prefix}${String(seq).padStart(p.width, "0")}${p.suffix}`;
}

export type NumberingGapInput = { id: string; invoiceNumber: string | null };

export type NumberingGap = {
  /** Numero de la factura anterior al hueco (tal cual esta guardado). */
  previousNumber: string;
  /** Numeros que faltan, con el formato de la serie. */
  missing: string[];
};

/** Para cada factura que va justo detras de un hueco, que numeros faltan
 *  antes de ella (dentro de su misma serie). */
export function findNumberingGaps(items: NumberingGapInput[]): Map<string, NumberingGap> {
  const bySeries = new Map<string, { id: string; raw: string; parsed: Parsed }[]>();

  for (const item of items) {
    if (!item.invoiceNumber) continue;
    const parsed = parseInvoiceNumber(item.invoiceNumber);
    if (!parsed) continue;
    const list = bySeries.get(parsed.series) ?? [];
    list.push({ id: item.id, raw: item.invoiceNumber.trim(), parsed });
    bySeries.set(parsed.series, list);
  }

  const gaps = new Map<string, NumberingGap>();
  for (const list of bySeries.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.parsed.seq - b.parsed.seq);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const diff = curr.parsed.seq - prev.parsed.seq;
      if (diff > 1 && diff <= MAX_GAP) {
        const missing: string[] = [];
        for (let n = prev.parsed.seq + 1; n < curr.parsed.seq; n++) {
          missing.push(formatLike(curr.parsed, n));
        }
        gaps.set(curr.id, { previousNumber: prev.raw, missing });
      }
    }
  }
  return gaps;
}
