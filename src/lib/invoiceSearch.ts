/**
 * Busqueda de texto en los listados de facturas: con que formas casa un
 * importe y como acotar un listado a los ids que casan cuando son demasiados
 * para mandarlos a la BD. Modulo puro (sin Prisma ni Next) para poder
 * probarlo; lo usa invoiceListing.ts.
 */

import { formatEur } from "@/lib/format";
import { pageWindow, type PageWindow } from "@/lib/listing";

/**
 * Por encima de esto no se manda `id IN (...)`: node-postgres escribe el
 * numero de parametros en 16 bits y pasados 65.535 la consulta falla. Mucho
 * antes ya es lenta.
 */
export const MAX_IDS_IN_QUERY = 10_000;

/** Si hay demasiados ids para un `id IN (...)`, el Set con el que filtrar en
 *  memoria; si caben (o no hay texto), null y se filtra en la BD. */
export function inMemoryIdFilter(ids: readonly string[] | null): Set<string> | null {
  return ids && ids.length > MAX_IDS_IN_QUERY ? new Set(ids) : null;
}

/** Formas de buscar un importe: como se teclea ("1134,6", "1134.60") y como
 *  lo pinta la tabla ("12.345,60 €": es-ES pone punto de miles desde 10.000). */
export function amountSearchVariants(total: number | null): string[] {
  if (total == null || !Number.isFinite(total)) return [];
  const fixed = total.toFixed(2);
  const plain = String(total);
  return [fixed, fixed.replace(".", ","), plain, plain.replace(".", ","), formatEur(total)];
}

/** Pagina de las filas que casan, a partir de TODOS los ids del listado ya
 *  ordenados por la BD. Sale lo mismo que `id IN (...)` + skip/take: el orden
 *  sigue siendo el de Postgres (collation incluida), aqui solo se filtra. */
export function pageOfMatching(
  orderedIds: readonly string[],
  matching: ReadonlySet<string>,
  page: number,
  pageSize?: number,
): { ids: string[]; window: PageWindow } {
  const kept = orderedIds.filter((id) => matching.has(id));
  const window = pageWindow(page, kept.length, pageSize);
  return { ids: kept.slice(window.skip, window.skip + window.take), window };
}

/** Cuantas de las filas que casan hay en cada estado. */
export function countStatusesMatching<S extends string>(
  rows: readonly { id: string; status: S }[],
  matching: ReadonlySet<string>,
): Partial<Record<S, number>> {
  const counts: Partial<Record<S, number>> = {};
  for (const row of rows) {
    if (matching.has(row.id)) counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}
