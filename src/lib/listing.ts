/**
 * Piezas comunes de los listados: paginacion, busqueda de texto y filtro de
 * periodo. Modulo puro (sin Prisma ni Next) para poder probarlo.
 */

/** Filas por pagina en los listados. */
export const PAGE_SIZE = 25;

/** Numero de pagina de la URL. Cualquier cosa rara es la primera. */
export function parsePage(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export type PageWindow = {
  /** Pagina efectiva, ya acotada a las que existen. */
  page: number;
  totalPages: number;
  skip: number;
  take: number;
  /** Primera y ultima fila que se ensenan (1-based), para "Mostrando 26-50 de 212". */
  from: number;
  to: number;
  total: number;
};

/** Ventana de una pagina. Si piden una pagina que ya no existe (se filtro y
 *  quedaron menos filas), se ensena la ultima en vez de una tabla vacia. */
export function pageWindow(requested: number, total: number, pageSize = PAGE_SIZE): PageWindow {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requested), totalPages);
  const skip = (page - 1) * pageSize;
  return {
    page,
    totalPages,
    skip,
    take: pageSize,
    from: total === 0 ? 0 : skip + 1,
    to: Math.min(skip + pageSize, total),
    total,
  };
}

/** Texto para comparar: sin tildes, sin mayusculas y sin espacios sobrantes.
 *  El gestor teclea "carnicas" y la factura pone "Cárnicas Joselito", o pega
 *  un numero copiado de A3 que arrastra un espacio. */
export function normalizeSearch(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** ¿Alguno de los campos contiene el texto buscado? Sin texto, todo vale. */
export function matchesSearch(fields: (string | null | undefined)[], query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return fields.some((f) => normalizeSearch(f).includes(q));
}

/** Valor del desplegable de periodo: "" (todos), "t1".."t4" o "m1".."m12". */
export type PeriodValue = string;

/** Filtro de periodMonth para Prisma a partir del mes o el trimestre de la
 *  URL. El trimestre manda: la asesoria trabaja por trimestres. */
export function periodMonthFilter(
  month: number | undefined,
  quarter: number | undefined,
): number | { gte: number; lte: number } | undefined {
  if (quarter !== undefined && quarter >= 1 && quarter <= 4) {
    return { gte: quarter * 3 - 2, lte: quarter * 3 };
  }
  if (month !== undefined && month >= 1 && month <= 12) return month;
  return undefined;
}

/** Entero de la URL dentro de un rango, o undefined. */
export function parseIntInRange(raw: string | null | undefined, min: number, max: number): number | undefined {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
