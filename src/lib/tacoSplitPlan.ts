/**
 * Rangos de páginas de un taco entero en un PDF a partir de las páginas donde
 * empieza cada factura (B-R7, B-R9). Puro: lo usan la subida del taco entero
 * (el tope de páginas) y la división.
 */

/** Páginas que admite el PDF de un taco entero. */
export const TACO_PDF_MAX_PAGES = 500;
/** Facturas que salen, como mucho, de un taco entero. */
export const TACO_SPLIT_MAX_PARTS = 300;

export type TacoRange = { start: number; end: number };

/**
 * Ordena las marcas y quita las repetidas. Cada factura va desde su marca
 * hasta la página anterior a la siguiente marca (la última, hasta el final
 * del PDF). Lo que hay antes de la primera marca no es de ninguna factura.
 */
export function planTacoRanges(
  startPages: readonly number[],
  pageCount: number,
): { ok: true; ranges: TacoRange[] } | { ok: false; error: string } {
  if (!Number.isInteger(pageCount) || pageCount < 1 || !startPages.every((page) => Number.isInteger(page))) {
    return { ok: false, error: "Las marcas no valen. Recarga la página." };
  }
  const starts = [...new Set(startPages)].sort((a, b) => a - b);
  if (starts.length === 0) return { ok: false, error: "Marca al menos dónde empieza una factura." };
  const outside = starts.find((page) => page < 1 || page > pageCount);
  if (outside !== undefined) {
    const pages = pageCount === 1 ? "1 página" : `${pageCount} páginas`;
    return { ok: false, error: `La página ${outside} no existe: el PDF tiene ${pages}.` };
  }
  if (starts.length > TACO_SPLIT_MAX_PARTS) {
    return { ok: false, error: `Como mucho ${TACO_SPLIT_MAX_PARTS} facturas por taco.` };
  }
  const ranges = starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1] - 1 : pageCount }));
  return { ok: true, ranges };
}
