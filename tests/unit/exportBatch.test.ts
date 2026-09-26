import { describe, it, expect } from "vitest";
import {
  buildExportSnapshot,
  exportStorageKey,
  firmExportBatchWhere,
  invoicesChangedSince,
  type ExportInvoice,
} from "@/lib/exportBatch";

function mkInvoice(overrides: Partial<ExportInvoice> = {}): ExportInvoice {
  return {
    id: "inv1",
    type: "PURCHASE",
    invoiceDate: new Date("2026-04-15"),
    invoiceNumber: "F-001",
    issuerName: "Suministros S.L.",
    issuerCif: "B12345674",
    receiverName: "Asesoría Cliente",
    receiverCif: "B87654321",
    taxBase: 100,
    vatRate: 21,
    vatAmount: 21,
    irpfRate: 0,
    irpfAmount: 0,
    totalAmount: 121,
    supplierAccount: "4000001",
    expenseAccount: "6000001",
    operationType: null,
    intracomGoodsType: null,
    retentionType: null,
    retentionBase: null,
    issuerCountry: null,
    receiverCountry: null,
    isRectificative: false,
    rectifiedInvoiceSeries: null,
    rectifiedInvoiceNumber: null,
    rectificativeType: null,
    art80Tres: false,
    client: { id: "c1", name: "ACME SL", cif: "B11111111" },
    vatLines: [],
    ...overrides,
  } as unknown as ExportInvoice;
}

describe("buildExportSnapshot", () => {
  it("conserva las claves y su orden (la revisión compara contra este JSON)", () => {
    const snapshot = JSON.parse(buildExportSnapshot(mkInvoice()));
    expect(Object.keys(snapshot)).toEqual([
      "issuerName", "issuerCif", "receiverName", "receiverCif", "invoiceNumber", "invoiceDate",
      "taxBase", "vatRate", "vatAmount", "irpfRate", "irpfAmount", "totalAmount", "vatLines",
      "supplierAccount", "expenseAccount", "operationType", "intracomGoodsType", "retentionType",
      "retentionBase", "issuerCountry", "receiverCountry", "isRectificative", "rectifiedInvoiceSeries",
      "rectifiedInvoiceNumber", "rectificativeType", "art80Tres", "type", "clientName", "clientCif",
    ]);
    expect(snapshot.clientName).toBe("ACME SL");
    expect(snapshot.invoiceDate).toBe("2026-04-15T00:00:00.000Z");
  });

  it("guarda las líneas de IVA con sus seis campos", () => {
    const snapshot = JSON.parse(
      buildExportSnapshot(
        mkInvoice({
          vatLines: [{
            id: "l1", invoiceId: "inv1", position: 0, taxBase: 100, vatRate: 21, vatAmount: 21,
            equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2,
          }] as unknown as ExportInvoice["vatLines"],
        }),
      ),
    );
    expect(snapshot.vatLines).toEqual([{
      position: 0, taxBase: 100, vatRate: 21, vatAmount: 21,
      equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2,
    }]);
  });
});

describe("invoicesChangedSince", () => {
  it("sin cambios no devuelve nada", () => {
    expect(invoicesChangedSince([mkInvoice()], [mkInvoice()])).toEqual([]);
  });

  it("detecta una corrección que cambia el fichero", () => {
    const generated = [mkInvoice(), mkInvoice({ id: "inv2" })];
    const current = [mkInvoice(), mkInvoice({ id: "inv2", invoiceNumber: "F-002" })];
    expect(invoicesChangedSince(generated, current)).toEqual(["inv2"]);
  });

  it("ignora lo que no viaja al fichero", () => {
    expect(
      invoicesChangedSince([mkInvoice()], [mkInvoice({ currency: "USD" } as Partial<ExportInvoice>)]),
    ).toEqual([]);
  });

  it("una factura que ya no aparece cuenta como cambiada", () => {
    expect(invoicesChangedSince([mkInvoice()], [])).toEqual(["inv1"]);
  });
});

describe("exportStorageKey", () => {
  it("guarda el xlsx bajo exports/<asesoría>/<lote>", () => {
    expect(exportStorageKey("firm1", "batch1", "a3excel")).toBe("exports/firm1/batch1.xlsx");
  });

  it("dos asesorías no comparten carpeta", () => {
    expect(exportStorageKey("firm1", "b", "a3excel")).not.toBe(exportStorageKey("firm2", "b", "a3excel"));
  });
});

describe("firmExportBatchWhere", () => {
  it("exige que el lote tenga facturas de clientes de la asesoría", () => {
    expect(firmExportBatchWhere("batch1", "firm1")).toEqual({
      id: "batch1",
      items: { some: { invoice: { client: { advisoryFirmId: "firm1" } } } },
    });
  });
});
