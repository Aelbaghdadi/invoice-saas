// Orden de los listados de facturas (tarea «Ordenar»): proveedor A-Z, fecha
// de factura y nº de registro, con paginación y búsqueda de texto.
import { describe, it, expect, beforeEach } from "vitest";
import type { Invoice } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { invoiceOrderBy, invoicePageIds, matchingInvoiceIds } from "@/lib/invoiceListing";

let w: FirmWorld;
let rows: Record<string, Invoice>;

/** Nº de registro puesto como al exportar: serie del cliente, tipo y año. */
async function register(invoice: Invoice, number: number) {
  const series = await prisma.invoiceRegisterSeries.upsert({
    where: { clientId_type_year: { clientId: invoice.clientId, type: invoice.type, year: invoice.periodYear } },
    create: { clientId: invoice.clientId, type: invoice.type, year: invoice.periodYear, lastNumber: 1000 },
    update: {},
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: { registerSeriesId: series.id, registerNumber: number, registeredAt: new Date("2026-10-05T10:00:00Z") },
  });
}

beforeEach(async () => {
  w = await makeFirm("A");
  const make = (over: Parameters<typeof makeInvoice>[1]) => makeInvoice(w.client, { status: "VALIDATED", ...over });
  rows = {
    zeta: await make({ issuerName: "Zapatería Pérez", invoiceDate: new Date("2026-09-01") }),
    abaco: await make({ type: "SALE", issuerName: w.client.name, receiverName: "Ábaco Formación", invoiceDate: new Date("2026-09-20") }),
    acme: await make({ issuerName: "acme", invoiceDate: null }),
    beta: await make({ issuerName: "Beta Suministros", invoiceDate: new Date("2026-09-10") }),
  };
  await register(rows.zeta, 2);
  await register(rows.beta, 1);
  await register(rows.abaco, 1);
});

/** Ids de la página, por nombre, con el orden de la URL. Solo las de la
 *  prueba: makeFirm crea otras facturas del mismo cliente. */
async function page(sort: string, dir?: string, opts: { page?: number; pageSize?: number; q?: string } = {}) {
  const where = { id: { in: Object.values(rows).map((r) => r.id) } };
  const { orderBy, memorySort } = invoiceOrderBy(sort, dir);
  const textIds = await matchingInvoiceIds(where, opts.q ?? "");
  const { ids, window } = await invoicePageIds({ where, textIds, orderBy, memorySort, page: opts.page ?? 1, pageSize: opts.pageSize });
  const name = (id: string) => Object.entries(rows).find(([, r]) => r.id === id)![0];
  return { names: ids.map(name), total: window.total };
}

describe("orden de los listados de facturas", () => {
  it("proveedor A-Z por el tercero (receptor en las emitidas), y al revés", async () => {
    expect((await page("proveedor", "asc")).names).toEqual(["abaco", "acme", "beta", "zeta"]);
    expect((await page("proveedor", "desc")).names).toEqual(["zeta", "beta", "acme", "abaco"]);
  });

  it("fecha de factura, la más reciente primero y sin fecha al final", async () => {
    expect((await page("fechafactura")).names).toEqual(["abaco", "beta", "zeta", "acme"]);
    expect((await page("fechafactura", "asc")).names).toEqual(["zeta", "beta", "abaco", "acme"]);
  });

  it("nº de registro: R antes que E y sin registrar al final", async () => {
    expect((await page("registro", "asc")).names).toEqual(["beta", "zeta", "abaco", "acme"]);
  });

  it("el orden en memoria pagina: cada factura sale en una sola página", async () => {
    const first = await page("proveedor", "asc", { page: 1, pageSize: 3 });
    const second = await page("proveedor", "asc", { page: 2, pageSize: 3 });
    expect([first.names, second.names, first.total]).toEqual([["abaco", "acme", "beta"], ["zeta"], 4]);
  });

  it("con texto buscado ordena solo lo que casa", async () => {
    expect(await page("proveedor", "asc", { q: "suministros" })).toEqual({ names: ["beta"], total: 1 });
  });
});
