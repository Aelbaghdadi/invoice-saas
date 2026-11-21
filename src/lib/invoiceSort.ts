import type { InvoiceType } from "@prisma/client";

/**
 * Orden de los listados de facturas que no puede hacer la BD con un orderBy
 * de Prisma: el tercero (emisor en recibidas, receptor en emitidas) y el nº
 * de registro (serie R/E, año y numero, en InvoiceArchive). Modulo puro, sin
 * Prisma ni Next, para poder probarlo.
 */

/** Columnas por las que se puede ordenar la lista de facturas. «fecha» es la
 *  de subida; «fechafactura», la que pone la factura. */
export const INVOICE_SORT_KEYS = ["fecha", "factura", "cliente", "periodo", "total", "fechafactura", "proveedor", "registro"] as const;
export type InvoiceSortKey = (typeof INVOICE_SORT_KEYS)[number];

export function parseInvoiceSortKey(raw: string | undefined): InvoiceSortKey {
  return (INVOICE_SORT_KEYS as readonly string[]).includes(raw ?? "") ? (raw as InvoiceSortKey) : "fecha";
}

/** Sentido al pulsar una columna que no es la activa: las fechas y los
 *  importes, lo mas reciente o lo mas alto primero; lo demas, de la A a la Z. */
export function defaultSortDir(key: InvoiceSortKey): "asc" | "desc" {
  return key === "fecha" || key === "fechafactura" || key === "total" ? "desc" : "asc";
}

/** Sentido al pulsar `key`: si ya es la activa, se invierte. */
export function nextSortDir(current: InvoiceSortKey, dir: "asc" | "desc", key: InvoiceSortKey): "asc" | "desc" {
  if (current !== key) return defaultSortDir(key);
  return dir === "desc" ? "asc" : "desc";
}

/** Lo que hace falta de cada factura para ordenarla en memoria. */
export type InvoiceSortRow = {
  id: string;
  type: InvoiceType;
  issuerName: string | null;
  receiverName: string | null;
  register: { type: InvoiceType; year: number; number: number } | null;
};

/** La otra parte de la factura: el cliente es la otra. */
export function thirdPartyName(row: Pick<InvoiceSortRow, "type" | "issuerName" | "receiverName">): string | null {
  const name = row.type === "SALE" ? row.receiverName : row.issuerName;
  return name?.trim() ? name.trim() : null;
}

// Sin tildes ni mayusculas, y «Proveedor 2» antes que «Proveedor 10».
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/** Las que no tienen el dato van al final en los dos sentidos, como
 *  `nulls: "last"` en el resto de columnas. null si empatan. */
function withNullsLast<T>(
  a: T | null,
  b: T | null,
  dir: "asc" | "desc",
  compare: (x: T, y: T) => number,
): number | null {
  if (a == null || b == null) return a == null && b == null ? null : a == null ? 1 : -1;
  const c = compare(a, b);
  return c === 0 ? null : dir === "asc" ? c : -c;
}

const REGISTER_TYPE_ORDER: Record<InvoiceType, number> = { PURCHASE: 0, SALE: 1 };

/** Comparador de filas para «proveedor» o «registro». El id desempata
 *  siempre: sin eso una factura podria salir en dos paginas. */
export function invoiceRowComparator(
  key: "proveedor" | "registro",
  dir: "asc" | "desc",
): (a: InvoiceSortRow, b: InvoiceSortRow) => number {
  return (a, b) => {
    const c = key === "proveedor"
      ? withNullsLast(thirdPartyName(a), thirdPartyName(b), dir, (x, y) => collator.compare(x, y))
      // Por serie: año, recibidas (R) antes que emitidas (E), y numero.
      : withNullsLast(a.register, b.register, dir, (x, y) =>
        x.year - y.year || REGISTER_TYPE_ORDER[x.type] - REGISTER_TYPE_ORDER[y.type] || x.number - y.number);
    return c ?? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
}
