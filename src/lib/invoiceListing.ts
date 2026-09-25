import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { matchesSearch, normalizeSearch, pageWindow, type PageWindow } from "@/lib/listing";

/**
 * Ids de una pagina de facturas, con busqueda de texto sin tildes.
 *
 * Sin texto, la paginacion va entera en BD (count + skip/take).
 *
 * Con texto no se puede: Postgres, desde Prisma, no busca sin tildes sin la
 * extension unaccent, y "carnicas" tiene que encontrar "Cárnicas Joselito".
 * Asi que se traen solo los campos buscables del conjunto YA filtrado
 * (cliente, periodo, tipo, estado: acotado) y se filtra aqui. Es barato:
 * son unas pocas columnas de texto por factura.
 *
 * `where` tiene que venir ya acotado a la asesoria (o a los clientes del
 * gestor): de eso depende que no se cuelen facturas de otra asesoria.
 */
export async function invoicePageIds(opts: {
  where: Prisma.InvoiceWhereInput;
  orderBy: Prisma.InvoiceOrderByWithRelationInput[];
  q: string;
  page: number;
  pageSize?: number;
}): Promise<{ ids: string[]; window: PageWindow }> {
  const { where, orderBy, q, page, pageSize } = opts;

  if (!normalizeSearch(q)) {
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

  const candidates = await prisma.invoice.findMany({
    where,
    orderBy,
    select: {
      id: true,
      invoiceNumber: true,
      filename: true,
      issuerName: true,
      issuerCif: true,
      receiverName: true,
      receiverCif: true,
      client: { select: { name: true, cif: true } },
    },
  });
  const hits = candidates.filter((c) =>
    matchesSearch(
      [c.invoiceNumber, c.filename, c.issuerName, c.issuerCif, c.receiverName, c.receiverCif, c.client.name, c.client.cif],
      q,
    ),
  );
  const window = pageWindow(page, hits.length, pageSize);
  return { ids: hits.slice(window.skip, window.skip + window.take).map((h) => h.id), window };
}

/** Reordena las filas en el orden de los ids: un `id in [...]` no lo garantiza. */
export function inIdOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
}

/** Columnas por las que se puede ordenar la lista de facturas. */
export type InvoiceSortKey = "fecha" | "factura" | "cliente" | "periodo" | "total";

/** Orden de Prisma para una columna. Siempre con el id al final: sin un
 *  desempate estable, dos facturas con la misma fecha pueden cambiar de
 *  pagina entre una peticion y la siguiente, y una se ve dos veces. */
export function invoiceOrderBy(
  sort: string | undefined,
  dir: string | undefined,
): { orderBy: Prisma.InvoiceOrderByWithRelationInput[]; sort: InvoiceSortKey; dir: "asc" | "desc" } {
  const d: "asc" | "desc" = dir === "asc" ? "asc" : "desc";
  const key: InvoiceSortKey =
    sort === "factura" || sort === "cliente" || sort === "periodo" || sort === "total" ? sort : "fecha";
  const byKey: Record<InvoiceSortKey, Prisma.InvoiceOrderByWithRelationInput[]> = {
    fecha: [{ createdAt: d }],
    factura: [{ invoiceNumber: d }],
    cliente: [{ client: { name: d } }],
    periodo: [{ periodYear: d }, { periodMonth: d }],
    total: [{ totalAmount: d }],
  };
  return { orderBy: [...byKey[key], { id: "asc" }], sort: key, dir: d };
}
