import type { InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { matchesSearch, normalizeSearch, pageWindow, type PageWindow } from "@/lib/listing";
import { amountSearchVariants, countStatusesMatching, inMemoryIdFilter, pageOfMatching } from "@/lib/invoiceSearch";
import { invoiceRowComparator, parseInvoiceSortKey, type InvoiceSortKey, type InvoiceSortRow } from "@/lib/invoiceSort";

export type { InvoiceSortKey } from "@/lib/invoiceSort";

/**
 * Ids de las facturas que casan con el texto buscado, sin tildes; null si no
 * hay texto.
 *
 * Postgres, desde Prisma, no busca sin tildes sin la extension unaccent, y
 * "carnicas" tiene que encontrar "Cárnicas Joselito". Asi que se traen solo
 * los campos buscables del conjunto YA filtrado (cliente, periodo, tipo) y se
 * filtra aqui. Son unas pocas columnas de texto por factura.
 *
 * Se aplica sobre el filtro BASE (sin estado ni bandeja) para que la lista y
 * los contadores de las pestañas salgan del mismo conjunto: si no, con texto
 * la lista decia 3 facturas y la pestaña 150.
 *
 * `where` tiene que venir ya acotado a la asesoria (o a los clientes del
 * gestor): de eso depende que no se cuelen facturas de otra asesoria.
 */
export async function matchingInvoiceIds(
  where: Prisma.InvoiceWhereInput,
  q: string,
): Promise<string[] | null> {
  if (!normalizeSearch(q)) return null;
  const candidates = await prisma.invoice.findMany({
    where,
    select: {
      id: true,
      invoiceNumber: true,
      filename: true,
      issuerName: true,
      issuerCif: true,
      receiverName: true,
      receiverCif: true,
      totalAmount: true,
      client: { select: { name: true, cif: true } },
    },
  });
  return candidates
    .filter((c) => {
      // El importe se busca como se teclea: "1134,6" o "1134.60".
      const total = c.totalAmount != null ? Number(c.totalAmount) : null;
      const importes = amountSearchVariants(total);
      return matchesSearch(
        [c.invoiceNumber, c.filename, c.issuerName, c.issuerCif, c.receiverName, c.receiverCif, c.client.name, c.client.cif, ...importes],
        q,
      );
    })
    .map((c) => c.id);
}

/** Limita un where a los ids que casan con el texto (si hay texto). Solo con
 *  listas que caben en una consulta: ver inMemoryIdFilter. */
function withinIds(
  where: Prisma.InvoiceWhereInput,
  ids: string[] | null,
): Prisma.InvoiceWhereInput {
  return ids ? { AND: [where, { id: { in: ids } }] } : where;
}

// Con muchos ids de texto (una letra suelta casa casi toda la asesoria), las
// funciones de abajo no mandan el `IN` gigante: traen los ids del where, que
// sigue filtrando y ordenando la BD, y se quedan aqui con los que casan.

/** Cuantas facturas del where casan con el texto (`ids` null: todas). */
export async function countWithin(
  where: Prisma.InvoiceWhereInput,
  ids: string[] | null,
): Promise<number> {
  const inMemory = inMemoryIdFilter(ids);
  if (!inMemory) return prisma.invoice.count({ where: withinIds(where, ids) });
  const rows = await prisma.invoice.findMany({ where, select: { id: true } });
  return rows.filter((r) => inMemory.has(r.id)).length;
}

/** Facturas del where que casan con el texto, contadas por estado. */
export async function statusCountsWithin(
  where: Prisma.InvoiceWhereInput,
  ids: string[] | null,
): Promise<Partial<Record<InvoiceStatus, number>>> {
  const inMemory = inMemoryIdFilter(ids);
  if (!inMemory) {
    const groups = await prisma.invoice.groupBy({ by: ["status"], where: withinIds(where, ids), _count: true });
    return Object.fromEntries(groups.map((g) => [g.status, g._count]));
  }
  const rows = await prisma.invoice.findMany({ where, select: { id: true, status: true } });
  return countStatusesMatching(rows, inMemory);
}

/** Ids de una pagina: count + skip/take con orden estable, en BD. Con
 *  demasiados ids de texto la BD ordena todo el where y aqui se corta. Con
 *  `memorySort` (un orden que la BD no sabe hacer) se ordena aqui todo el
 *  where, con solo las columnas que hacen falta. */
export async function invoicePageIds(opts: {
  where: Prisma.InvoiceWhereInput;
  /** Lo que devuelve matchingInvoiceIds: null si no hay texto. */
  textIds: string[] | null;
  orderBy: Prisma.InvoiceOrderByWithRelationInput[];
  memorySort?: ((a: InvoiceSortRow, b: InvoiceSortRow) => number) | null;
  page: number;
  pageSize?: number;
}): Promise<{ ids: string[]; window: PageWindow }> {
  const { textIds, orderBy, memorySort, page, pageSize } = opts;
  const inMemory = inMemoryIdFilter(textIds);
  if (memorySort) {
    const rows = await prisma.invoice.findMany({
      where: inMemory ? opts.where : withinIds(opts.where, textIds),
      select: {
        id: true,
        type: true,
        issuerName: true,
        receiverName: true,
        archive: { select: { registerNumber: true, registerSeries: { select: { type: true, year: true } } } },
      },
    });
    const sorted = rows
      .filter((r) => !inMemory || inMemory.has(r.id))
      .map((r): InvoiceSortRow => ({
        id: r.id,
        type: r.type,
        issuerName: r.issuerName,
        receiverName: r.receiverName,
        register: r.archive?.registerSeries && r.archive.registerNumber != null
          ? { ...r.archive.registerSeries, number: r.archive.registerNumber }
          : null,
      }))
      .sort(memorySort);
    const window = pageWindow(page, sorted.length, pageSize);
    return { ids: sorted.slice(window.skip, window.skip + window.take).map((r) => r.id), window };
  }
  if (inMemory) {
    const rows = await prisma.invoice.findMany({ where: opts.where, orderBy, select: { id: true } });
    return pageOfMatching(rows.map((r) => r.id), inMemory, page, pageSize);
  }
  const where = withinIds(opts.where, textIds);
  const total = await prisma.invoice.count({ where });
  const window = pageWindow(page, total, pageSize);
  const rows = await prisma.invoice.findMany({
    where,
    orderBy,
    skip: window.skip,
    take: window.take,
    select: { id: true },
  });
  return { ids: rows.map((r) => r.id), window };
}

/** Lo que reprocesa "Reprocesar todas" en Error OCR: todas las de la
 *  asesoria, sin los filtros del listado. El boton cuenta con este mismo
 *  where para que su numero sea lo que la accion reprocesa de verdad. */
export function ocrErrorsToReprocessWhere(firmId: string | undefined): Prisma.InvoiceWhereInput {
  return { status: "OCR_ERROR", client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } };
}

/** Reordena las filas en el orden de los ids: un `id in [...]` no lo garantiza. */
export function inIdOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}

/** Orden de Prisma para una columna. Siempre con el id al final: sin un
 *  desempate estable, dos facturas con la misma fecha pueden cambiar de
 *  pagina entre una peticion y la siguiente, y una se ve dos veces.
 *  Las que no tienen numero, fecha o importe van al final en los dos
 *  sentidos: en descendente, Postgres las ponia primero. El tercero y el nº
 *  de registro no los ordena la BD: van en `memorySort` (invoiceSort.ts). */
export function invoiceOrderBy(
  sort: string | undefined,
  dir: string | undefined,
): {
  orderBy: Prisma.InvoiceOrderByWithRelationInput[];
  memorySort: ((a: InvoiceSortRow, b: InvoiceSortRow) => number) | null;
  sort: InvoiceSortKey;
  dir: "asc" | "desc";
} {
  const d: "asc" | "desc" = dir === "asc" ? "asc" : "desc";
  const key = parseInvoiceSortKey(sort);
  const byKey: Record<Exclude<InvoiceSortKey, "proveedor" | "registro">, Prisma.InvoiceOrderByWithRelationInput[]> = {
    fecha: [{ createdAt: d }],
    factura: [{ invoiceNumber: { sort: d, nulls: "last" } }],
    cliente: [{ client: { name: d } }],
    periodo: [{ periodYear: d }, { periodMonth: d }],
    total: [{ totalAmount: { sort: d, nulls: "last" } }],
    fechafactura: [{ invoiceDate: { sort: d, nulls: "last" } }],
  };
  if (key === "proveedor" || key === "registro") {
    return { orderBy: [{ id: "asc" }], memorySort: invoiceRowComparator(key, d), sort: key, dir: d };
  }
  return { orderBy: [...byKey[key], { id: "asc" }], memorySort: null, sort: key, dir: d };
}
