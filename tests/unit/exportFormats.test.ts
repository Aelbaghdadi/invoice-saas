import { describe, it, expect } from "vitest";
import {
  generateCsv,
  suggestFilename,
  validateForA3Export,
  type InvoiceWithClient,
} from "@/lib/exportFormats";

function mkInvoice(overrides: Partial<InvoiceWithClient> = {}): InvoiceWithClient {
  return {
    id: "inv-1",
    type: "PURCHASE",
    invoiceDate: new Date("2026-04-15"),
    invoiceNumber: "F-001",
    issuerName: "Suministros S.L.",
    issuerCif: "B12345674",
    receiverName: "Asesoría Cliente",
    receiverCif: "B87654321",
    taxBase: 100 as any,
    vatRate: 21 as any,
    vatAmount: 21 as any,
    irpfRate: 0 as any,
    irpfAmount: 0 as any,
    totalAmount: 121 as any,
    supplierAccount: "4000001",
    expenseAccount: "6000001",
    client: { id: "c1", name: "ACME SL" } as any,
    ...overrides,
  } as InvoiceWithClient;
}

describe("generateCsv", () => {
  it("produces BOM + header + row for sage50", () => {
    const csv = generateCsv([mkInvoice()], "sage50");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const [header, row] = csv.slice(1).split("\r\n");
    expect(header.split(";").length).toBe(11);
    expect(row.split(";")).toEqual([
      "R", "15/04/2026", "F-001", "Suministros S.L.", "B12345674",
      "100,00", "21,00", "21,00", "0,00", "0,00", "121,00",
    ]);
  });

  it("emits E for SALE in sage50", () => {
    const csv = generateCsv([mkInvoice({ type: "SALE" })], "sage50");
    expect(csv).toMatch(/\r\nE;/);
  });

  it("uses C/V codes for contasol", () => {
    const purchase = generateCsv([mkInvoice({ type: "PURCHASE" })], "contasol");
    const sale = generateCsv([mkInvoice({ type: "SALE" })], "contasol");
    expect(purchase).toMatch(/\r\nC;/);
    expect(sale).toMatch(/\r\nV;/);
  });

  it("uses 1/2 codes for a3con", () => {
    const purchase = generateCsv([mkInvoice({ type: "PURCHASE" })], "a3con");
    const sale = generateCsv([mkInvoice({ type: "SALE" })], "a3con");
    expect(purchase).toMatch(/\r\n1;/);
    expect(sale).toMatch(/\r\n2;/);
  });

  it("respects custom delimiter", () => {
    const csv = generateCsv([mkInvoice()], "sage50", { delimiter: "," });
    expect(csv).toMatch(/,/);
    expect(csv.split(",").length).toBeGreaterThan(5);
  });

  it("respects custom date format", () => {
    const csv = generateCsv([mkInvoice()], "sage50", { dateFormat: "YYYY-MM-DD" });
    expect(csv).toContain("2026-04-15");
  });

  it("formats amounts with Spanish decimal comma", () => {
    const csv = generateCsv([mkInvoice({ taxBase: 1234.56 as any })], "sage50");
    expect(csv).toContain("1234,56");
  });

  it("handles null amounts as 0,00", () => {
    const csv = generateCsv(
      [mkInvoice({ taxBase: null, vatAmount: null, totalAmount: null })],
      "sage50",
    );
    expect(csv).toContain(";0,00;");
  });

  it("a3con emits 9 columns (no IRPF)", () => {
    const csv = generateCsv([mkInvoice()], "a3con");
    const [header, row] = csv.slice(1).split("\r\n");
    expect(header.split(";").length).toBe(9);
    expect(row.split(";").length).toBe(9);
  });
});

describe("suggestFilename", () => {
  it("includes client, year-month, format and csv extension", () => {
    expect(suggestFilename([mkInvoice()], "sage50", 4, 2026)).toBe(
      "facturas_ACME_SL_2026-04_sage50.csv",
    );
  });

  it("uses xlsx for a3excel", () => {
    expect(suggestFilename([mkInvoice()], "a3excel", 12, 2025)).toBe(
      "facturas_ACME_SL_2025-12_a3excel.xlsx",
    );
  });

  it("falls back to 'cliente' when list empty", () => {
    expect(suggestFilename([], "sage50", 1, 2026)).toBe(
      "facturas_cliente_2026-01_sage50.csv",
    );
  });
});

describe("validateForA3Export", () => {
  it("returns empty for a well-formed invoice", () => {
    expect(validateForA3Export([mkInvoice()])).toEqual([]);
  });

  it("warns on missing NIF (purchase → issuerCif)", () => {
    const res = validateForA3Export([mkInvoice({ issuerCif: null })]);
    expect(res).toHaveLength(1);
    expect(res[0].warnings).toContain("NIF vacío");
  });

  it("warns on missing supplier/expense accounts", () => {
    const res = validateForA3Export([
      mkInvoice({ supplierAccount: null, expenseAccount: null }),
    ]);
    expect(res[0].warnings).toEqual(
      expect.arrayContaining(["Sin cuenta proveedor", "Sin cuenta gasto"]),
    );
  });

  it("warns on Base+IVA mismatch vs Total", () => {
    const res = validateForA3Export([
      mkInvoice({ taxBase: 100 as any, vatAmount: 21 as any, totalAmount: 130 as any }),
    ]);
    expect(res[0].warnings.some((w) => w.includes("Descuadre"))).toBe(true);
  });

  it("does not warn on rounding within 1 cent", () => {
    const res = validateForA3Export([
      mkInvoice({ taxBase: 100 as any, vatAmount: 21 as any, totalAmount: 121.005 as any }),
    ]);
    expect(res).toEqual([]);
  });

  it("uses receiverCif for SALE invoices", () => {
    const res = validateForA3Export([
      mkInvoice({ type: "SALE", issuerCif: null, receiverCif: "B87654321" }),
    ]);
    expect(res).toEqual([]);
  });
});
