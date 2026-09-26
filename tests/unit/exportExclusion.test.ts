import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  a3ExclusionReason,
  generateA3Excel,
  partitionA3Exportable,
  validateForA3Export,
  type InvoiceWithClient,
} from "@/lib/exportFormats";

function mkInvoice(id: string, totalAmount: number | null, splitInvoices?: number): InvoiceWithClient {
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
    ...(splitInvoices !== undefined ? { _count: { splitInvoices } } : {}),
  } as unknown as InvoiceWithClient;
}

describe("a3ExclusionReason", () => {
  it.each([0, 0.004, -0.004, null])("excluye total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBe("total_cero");
  });

  it.each([0.01, -121, 121])("deja pasar total %j", (total) => {
    expect(a3ExclusionReason(mkInvoice("x", total))).toBeNull();
    expect(a3ExclusionReason(mkInvoice("x", total, 0))).toBeNull();
  });

  it("excluye la original de una división aunque esté VALIDATED y con importe (van sus hijas)", () => {
    expect(a3ExclusionReason(mkInvoice("x", 121, 2))).toBe("dividida");
    // Dividida y con total 0: cuenta como dividida, que es lo que hay que arreglar.
    expect(a3ExclusionReason(mkInvoice("x", 0, 1))).toBe("dividida");
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
    expect(excluded).toEqual([{ invoice: expect.objectContaining({ id: "b" }), reason: "total_cero" }]);
  });

  it("el Excel lleva exactamente las exportables", () => {
    const invoices = [mkInvoice("a", 121), mkInvoice("b", 0), mkInvoice("c", 242), mkInvoice("d", 500, 2)];
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

  it("la original dividida lo dice con su motivo", () => {
    const [warning] = validateForA3Export([mkInvoice("d", 121, 2)]);
    expect(warning.warnings.join(" ")).toContain("Se dividió en otras facturas");
  });
});
