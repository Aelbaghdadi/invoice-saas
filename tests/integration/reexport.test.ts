// F-018: las corregidas despues de exportarse se ven en la vista previa, piden
// confirmacion y van, ademas, en una hoja aparte del Excel.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { GET as exportPreview, POST as exportDownload } from "@/app/api/export/route";
import { generateA3Excel } from "@/lib/exportFormats";
import { exportInvoiceWhere } from "@/lib/exportRequest";
import type { ExportInvoice } from "@/lib/exportBatch";
import { REEXPORT_SHEET_NAME } from "@/lib/reexportChanges";

let w: FirmWorld;
const april = { status: "VALIDATED" as const, periodMonth: 4, invoiceDate: new Date("2026-04-15") };
const request = { periodType: "MONTHLY" as const, month: 4, year: 2026, type: "ALL" as const, format: "a3excel" as const };

const preview = async () => {
  const res = await exportPreview(new NextRequest(
    `http://app.local/api/export?clientId=${w.client.id}&periodType=MONTHLY&month=4&year=2026&preview=1`,
  ));
  expect(res.status).toBe(200);
  return res.json();
};
const download = (confirmedReexports?: string[]) => exportDownload(new NextRequest("http://app.local/api/export", {
  method: "POST",
  headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
  body: JSON.stringify({ ...request, clientId: w.client.id, ...(confirmedReexports ? { confirmedReexports } : {}) }),
}));
const sheets = async (res: Response) => {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()));
  return Object.fromEntries(wb.SheetNames.map((name) => [name, XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 })]));
};

let adminName: string;
let corrected: string;
let fresh: string;

beforeEach(async () => {
  w = await makeFirm("A");
  signInAs(w.admin);
  adminName = (await prisma.user.findUniqueOrThrow({ where: { id: w.admin.id } })).name;
  corrected = (await makeInvoice(w.client, { ...april, invoiceNumber: "F-1" })).id;
  expect((await download()).status).toBe(200);
  // La correccion tras exportar: la revision la saca otra vez de la cola
  // (exportBatchId a null) porque cambia lo que ve A3.
  await prisma.invoice.update({ where: { id: corrected }, data: { invoiceNumber: "F-1B", totalAmount: 120, exportBatchId: null } });
  fresh = (await makeInvoice(w.client, { ...april, invoiceNumber: "F-2", totalAmount: 363, taxBase: 300, vatAmount: 63 })).id;
});

describe("vista previa (F-018)", () => {
  it("cuenta las reexportadas, con el lote anterior y lo que cambia", async () => {
    const body = await preview();
    expect(body.count).toBe(2);
    expect(body.reexportCount).toBe(1);
    expect(body.reexportIds).toEqual([corrected]);
    const [r] = body.reexports;
    expect(r).toMatchObject({ invoiceId: corrected, invoiceNumber: "F-1B", thirdPartyName: "Proveedor SL", previousExportBy: adminName });
    expect(new Date(r.previousExportAt).getTime()).toBeGreaterThan(0);
    expect(r.changes).toEqual([
      { field: "Nº factura", before: "F-1", after: "F-1B" },
      { field: "Total", before: "121,00", after: "120,00" },
    ]);
  });
});

describe("descarga con reexportadas (F-018)", () => {
  it("sin confirmar: 409 ERR-EXPORT-008 y no se marca nada", async () => {
    const res = await download();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "ERR-EXPORT-008" });
    expect(await prisma.exportBatch.count()).toBe(1);
    expect(await prisma.invoice.count({ where: { id: { in: [corrected, fresh] }, exportBatchId: { not: null } } })).toBe(0);
  });

  it("confirmando otras (una corregida entre la vista previa y la descarga): 409", async () => {
    expect((await download([fresh])).status).toBe(409);
  });

  it("confirmada: la hoja aparte al final y la principal igual que sin ella", async () => {
    const candidates = await prisma.invoice.findMany({
      where: exportInvoiceWhere({ ...request, clientId: w.client.id }, w.firm.id),
      include: { client: true, vatLines: { orderBy: { position: "asc" } } },
      orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
    }) as ExportInvoice[];
    const wb = XLSX.read(generateA3Excel(candidates));
    const expected = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Facturas recibidas"], { header: 1 });

    const res = await download([corrected]);
    expect(res.status).toBe(200);
    const book = await sheets(res);
    expect(Object.keys(book)).toEqual(["Facturas recibidas", REEXPORT_SHEET_NAME]);
    expect(book["Facturas recibidas"]).toEqual(expected);
    const [header, ...rows] = book[REEXPORT_SHEET_NAME];
    expect(header).toEqual(["Nº factura", "NIF", "Nombre", "Exportada antes el", "Exportada por", "Campo", "Antes", "Ahora"]);
    expect(rows.map((row) => [row[0], row[1], row[2], row[4], row[5], row[6], row[7]])).toEqual([
      ["F-1B", "B12345674", "Proveedor SL", adminName, "Nº factura", "F-1", "F-1B"],
      ["F-1B", "B12345674", "Proveedor SL", adminName, "Total", "121,00", "120,00"],
    ]);
    expect(await prisma.invoice.count({ where: { id: { in: [corrected, fresh] }, exportBatchId: { not: null } } })).toBe(2);
  });

  it("sin reexportadas, el Excel no lleva la hoja", async () => {
    await prisma.invoice.update({ where: { id: corrected }, data: { status: "REJECTED" } });
    const res = await download();
    expect(res.status).toBe(200);
    expect(Object.keys(await sheets(res))).toEqual(["Facturas recibidas"]);
  });
});
