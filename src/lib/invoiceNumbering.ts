/**
 * Deteccion de huecos en la numeracion de facturas: dentro de un mismo
 * emisor (o cliente, en emitidas), si los numeros van 1, 2, 4... avisa de
 * que falta el 3.
 *
 * Heuristica de parseo: el correlativo es el ULTIMO tramo de digitos del
 * numero de factura; todo lo anterior (normalizado a mayusculas) es la
 * "serie". Cubre formatos como "2026-045", "FRA0001", "A/123" o "12". Si
 * no hay ningun digito no se puede ubicar en una secuencia y se ignora.
 */

// Saltos mayores que esto casi seguro son series distintas que han caido en
// el mismo grupo (o un OCR mal leido), no un hueco real que avisar.
const MAX_GAP = 50;

type Parsed = { series: string; seq: number };

export function parseInvoiceNumber(raw: string): Parsed | null {
  const match = raw.trim().match(/^(.*?)(\d+)$/);
  if (!match) return null;
  const [, prefix, digits] = match;
  return { series: prefix.trim().toUpperCase(), seq: parseInt(digits, 10) };
}

export type NumberingGapInput = { id: string; invoiceNumber: string | null };

/** Para cada factura que va justo detras de un hueco, la lista de
 *  correlativos que faltan antes de ella (dentro de su misma serie). */
export function findNumberingGaps(items: NumberingGapInput[]): Map<string, number[]> {
  const bySeries = new Map<string, { id: string; seq: number }[]>();

  for (const item of items) {
    if (!item.invoiceNumber) continue;
    const parsed = parseInvoiceNumber(item.invoiceNumber);
    if (!parsed) continue;
    const list = bySeries.get(parsed.series) ?? [];
    list.push({ id: item.id, seq: parsed.seq });
    bySeries.set(parsed.series, list);
  }

  const gaps = new Map<string, number[]>();
  for (const list of bySeries.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i].seq - sorted[i - 1].seq;
      if (diff > 1 && diff <= MAX_GAP) {
        const missing: number[] = [];
        for (let n = sorted[i - 1].seq + 1; n < sorted[i].seq; n++) missing.push(n);
        gaps.set(sorted[i].id, missing);
      }
    }
  }
  return gaps;
}
