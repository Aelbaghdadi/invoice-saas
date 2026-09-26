import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  a3ExclusionReason,
  generateA3Excel,
  partitionA3Exportable,
  validateForA3Export,
  type InvoiceWithClient,
} from "@/lib/exportFormats";

function mkInvoice(id: string, totalAmount: number | null): InvoiceWithClient {
  return {
    id,
    type: "PURCHASE",
    invoiceDate: new Date("2026-04-15"),
    invoiceNumber: `F-${id}`,
    issuerName: "Suministros S.L.",
    issuerCif: "B12345674",
    receiverName: "Cliente",
    receiverCif: "B87654321",
    taxBase: totalAmount ? 100 : 0,
    vatRate: 21,
    vatAmount: totalAmount ? 21 : 0,
    irpfRate: 0,
    irpfAmount: 0,
    totalAmount,
    supplierAccount: "4000001",
    expenseAccount: "6000001",
    client: { id: "c1", name: "ACME SL" },
  } as unknown as InvoiceWithClient;
}

describe("a3ExclusionReason", () => {
  it.each([0, 0.004, -0.004, null])("excluye total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBe("total 0");
  });

  it.each([0.01, -121, 121])("deja pasar total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBeNull();
  });
});

describe("partitionA3Exportable", () => {
  it("separa las que van al Excel de las que no, sin perder el orden", () => {
    const { exportable, excluded } = partitionA3Exportable([
      mkInvoice("a", 121),
      mkInvoice("b", 0),
      mkInvoice("c", -60.5),
    ]);
    expect(exportable.map((i) => i.id)).toEqual(["a", "c"]);
    expect(excluded).toEqual([{ invoice: expect.objectContaining({ id: "b" }), reason: "total 0" }]);
  });

  it("el Excel lleva exactamente las exportables", () => {
    const invoices = [mkInvoice("a", 121), mkInvoice("b", 0), mkInvoice("c", 242)];
    const wb = XLSX.read(generateA3Excel(invoices), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Facturas recibidas"], { header: 1 });
    const numbers = rows.slice(1).map((r) => r[3]);
    expect(numbers).toEqual(partitionA3Exportable(invoices).exportable.map((i) => i.invoiceNumber));
  });
});

describe("aviso de factura excluida", () => {
  it("dice que no entra en el Excel ni se marca como exportada", () => {
    const [warning] = validateForA3Export([mkInvoice("b", 0)]);
    expect(warning.warnings.join(" ")).toContain("no entra en el Excel ni se marca como exportada");
  });
});
