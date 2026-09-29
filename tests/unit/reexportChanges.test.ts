import { describe, it, expect } from "vitest";
import { a3Identity, reexportChanges, reexportSheetRows } from "@/lib/reexportChanges";
import { exportFingerprint } from "@/lib/exportFingerprint";

const exported = {
  type: "PURCHASE",
  invoiceDate: "2026-04-15T00:00:00.000Z",
  invoiceNumber: "F-1",
  issuerName: "Proveedor SL",
  issuerCif: "B12345674",
  issuerCountry: null,
  receiverName: "Cliente SL",
  receiverCif: "B87654321",
  operationType: "INTERIOR",
  supplierAccount: "40000001",
  expenseAccount: "60000001",
  irpfRate: null,
  irpfAmount: null,
  totalAmount: "1210",
  isRectificative: false,
  // Como lo guarda buildExportSnapshot: Decimal serializado como texto.
  vatLines: [{ position: 0, taxBase: "1000", vatRate: "21", vatAmount: "210", equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null }],
  clientName: "Cliente SL",
};
const snapshot = JSON.stringify(exported);

describe("reexportChanges (F-018)", () => {
  it("lo mismo que el snapshot: sin cambios", () => {
    expect(reexportChanges(snapshot, { ...exported, invoiceDate: new Date("2026-04-15"), totalAmount: 1210 })).toEqual([]);
  });

  it("cada columna que cambia, con su nombre y en formato español", () => {
    expect(reexportChanges(snapshot, {
      ...exported,
      invoiceDate: new Date("2026-04-16"),
      issuerCif: "515160873",
      issuerCountry: "PT",
      supplierAccount: "40000002",
      irpfRate: 15,
      irpfAmount: 150,
      totalAmount: 1060,
    })).toEqual([
      { field: "Fecha", before: "15/04/2026", after: "16/04/2026" },
      { field: "NIF", before: "B12345674", after: "PT515160873" },
      { field: "Cuenta de proveedor", before: "40000001", after: "40000002" },
      { field: "% IRPF", before: "0,00", after: "15,00" },
      { field: "Cuota IRPF", before: "0,00", after: "150,00" },
      { field: "Total", before: "1210,00", after: "1060,00" },
    ]);
  });

  it("en una emitida, el tercero es el receptor y las cuentas son de cliente e ingreso", () => {
    const sale = { ...exported, type: "SALE", receiverName: "Comprador SA", receiverCif: "A58818501" };
    expect(reexportChanges(JSON.stringify(sale), { ...sale, receiverName: "Comprador, S.A.", expenseAccount: "70000001" })).toEqual([
      { field: "Nombre", before: "Comprador SA", after: "Comprador, S.A." },
      { field: "Cuenta de ingreso", before: "60000001", after: "70000001" },
    ]);
  });

  it("marcarla como rectificativa cambia el número que ve A3 (sufijo _R)", () => {
    expect(reexportChanges(snapshot, { ...exported, isRectificative: true })).toEqual([
      { field: "Nº factura", before: "F-1", after: "F-1_R" },
    ]);
  });

  it("el desglose de IVA, en una sola entrada", () => {
    expect(reexportChanges(snapshot, {
      ...exported,
      vatLines: [
        { taxBase: 900, vatRate: 21, vatAmount: 189 },
        { taxBase: 100, vatRate: 10, vatAmount: 10, equivalenceSurchargeRate: 1.4, equivalenceSurchargeAmount: 1.4 },
      ],
    })).toEqual([{
      field: "Desglose de IVA",
      before: "1000,00 al 21 % (cuota 210,00)",
      after: "100,00 al 10 % (cuota 10,00, recargo 1,40 % (1,40)) · 900,00 al 21 % (cuota 189,00)",
    }]);
  });

  it("reordenar el desglose no es un cambio (la huella tampoco lo cuenta)", () => {
    const two = { ...exported, vatLines: [{ taxBase: 500, vatRate: 21, vatAmount: 105 }, { taxBase: 500, vatRate: 10, vatAmount: 50 }] };
    const swapped = { ...two, vatLines: [...two.vatLines].reverse() };
    expect(reexportChanges(JSON.stringify(two), swapped)).toEqual([]);
    expect(exportFingerprint(two)).toBe(exportFingerprint(swapped));
  });

  it("lo que no va al fichero (moneda, cliente) no aparece", () => {
    expect(reexportChanges(snapshot, { ...exported, currency: "USD", clientName: "Otro" })).toEqual([]);
  });

  it("hay cambios justo cuando la huella difiere", () => {
    for (const change of [{ invoiceNumber: "F-2" }, { operationType: "INTRACOM_BIENES" }, { totalAmount: 0 }, { vatLines: [] }]) {
      const current = { ...exported, ...change };
      expect(reexportChanges(snapshot, current)!.length > 0).toBe(exportFingerprint(current) !== exportFingerprint(exported));
    }
  });

  it("snapshot ilegible: null", () => {
    expect(reexportChanges("{no es json", exported)).toBeNull();
    expect(reexportChanges("[1,2]", exported)).toBeNull();
    expect(reexportChanges("null", exported)).toBeNull();
  });
});

describe("a3Identity (revisión 1 del PR #13, punto 2)", () => {
  it("el número, el NIF y el nombre del último Excel, no los de ahora", () => {
    expect(a3Identity(snapshot, { ...exported, invoiceNumber: "F-1B", issuerCif: "A58818501", issuerName: "Otro SL" }))
      .toEqual({ invoiceNumber: "F-1", nif: "B12345674", name: "Proveedor SL" });
  });

  it("una rectificativa está en A3 con «_R»", () => {
    expect(a3Identity(JSON.stringify({ ...exported, isRectificative: true }), exported).invoiceNumber).toBe("F-1_R");
  });

  it("en una emitida, el receptor; un extranjero, con su país", () => {
    const sale = { ...exported, type: "SALE", receiverName: "Comprador", receiverCif: "515160873", receiverCountry: "PT" };
    expect(a3Identity(JSON.stringify(sale), exported)).toEqual({ invoiceNumber: "F-1", nif: "PT515160873", name: "Comprador" });
  });

  it("sin snapshot legible, los actuales", () => {
    expect(a3Identity("{roto", { ...exported, invoiceNumber: "F-9" }).invoiceNumber).toBe("F-9");
  });
});

describe("reexportSheetRows (F-018)", () => {
  const base = {
    invoiceId: "i1", a3InvoiceNumber: "F-1", a3Nif: "B12345674", a3Name: "Proveedor SL",
    previousExportAt: new Date("2026-05-02T08:30:00Z"), previousExportBy: "Ana",
  };

  it("una fila por cambio, con la factura repetida", () => {
    expect(reexportSheetRows([{ ...base, changes: [
      { field: "Total", before: "121,00", after: "120,00" },
      { field: "Fecha", before: "15/04/2026", after: "16/04/2026" },
    ] }])).toEqual([
      ["Nº factura en A3", "NIF en A3", "Nombre en A3", "Exportada antes el", "Exportada por", "Campo", "Antes", "Ahora"],
      ["F-1", "B12345674", "Proveedor SL", "02/05/2026 10:30", "Ana", "Total", "121,00", "120,00"],
      ["F-1", "B12345674", "Proveedor SL", "02/05/2026 10:30", "Ana", "Fecha", "15/04/2026", "16/04/2026"],
    ]);
  });

  it("sin snapshot legible o sin quien la exportó, la fila sale igual", () => {
    expect(reexportSheetRows([{ ...base, previousExportBy: null, changes: null }])[1])
      .toEqual(["F-1", "B12345674", "Proveedor SL", "02/05/2026 10:30", "—", "—", "No se puede comparar con el Excel anterior", ""]);
  });
});
