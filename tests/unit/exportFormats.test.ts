import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  generateCsv,
  generateA3Excel,
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

  // Multi-IVA: una factura con varios tipos genera N filas (una por tipo).
  // Tu cliente A3 espera "repetir fila con todo igual cambiando %IVA y cuota".
  it("emits one row per VAT line for multi-VAT invoices", () => {
    const inv = mkInvoice({
      taxBase: 100 as any,
      vatAmount: 20 as any,
      totalAmount: 120 as any,
      vatLines: [
        { id: "v1", invoiceId: "inv-1", position: 0, taxBase: 50 as any, vatRate: 4 as any, vatAmount: 2 as any, createdAt: new Date() },
        { id: "v2", invoiceId: "inv-1", position: 1, taxBase: 30 as any, vatRate: 10 as any, vatAmount: 3 as any, createdAt: new Date() },
        { id: "v3", invoiceId: "inv-1", position: 2, taxBase: 20 as any, vatRate: 21 as any, vatAmount: 4.20 as any, createdAt: new Date() },
      ] as any,
    });
    const csv = generateCsv([inv], "sage50");
    const dataRows = csv.slice(1).split("\r\n").slice(1);
    expect(dataRows).toHaveLength(3);
    // Tipo, fecha, num, nombre, cif iguales en todas; base/%/cuota varian.
    const cols = (r: string) => r.split(";");
    expect(cols(dataRows[0])[6]).toBe("4,00");   // %IVA primera
    expect(cols(dataRows[1])[6]).toBe("10,00");
    expect(cols(dataRows[2])[6]).toBe("21,00");
    // Total solo en la primera fila para que no se duplique al sumar.
    expect(cols(dataRows[0])[10]).toBe("120,00");
    expect(cols(dataRows[1])[10]).toBe("0,00");
    expect(cols(dataRows[2])[10]).toBe("0,00");
  });

  it("falls back to flat fields when no vatLines", () => {
    const csv = generateCsv([mkInvoice()], "a3con");
    const dataRows = csv.slice(1).split("\r\n").slice(1);
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0].split(";")[6]).toBe("21,00");
  });

  it("rectificativa with mixed multi-VAT (one +, one -) emits both signs", () => {
    // Caso del doc: 21% da +50 y 10% da -20. A3 espera 2 filas con sus
    // signos respectivos para que sume/reste cada IVA por separado.
    const inv = mkInvoice({
      isRectificative: true as any,
      taxBase: 30 as any,         // 100 + (-50) si fueran bases coherentes
      vatAmount: 8.50 as any,     // 21*100/100 + 10*(-50)/100 / ajustado
      totalAmount: 38.50 as any,
      invoiceNumber: "F24-001",
      vatLines: [
        { id: "v1", invoiceId: "inv-1", position: 0, taxBase: 100 as any,  vatRate: 21 as any, vatAmount: 21 as any,    createdAt: new Date() },
        { id: "v2", invoiceId: "inv-1", position: 1, taxBase: -125 as any, vatRate: 10 as any, vatAmount: -12.5 as any, createdAt: new Date() },
      ] as any,
    });
    const csv = generateCsv([inv], "sage50");
    const dataRows = csv.slice(1).split("\r\n").slice(1);
    expect(dataRows).toHaveLength(2);
    const cols = (r: string) => r.split(";");
    // Fila 1: positiva
    expect(cols(dataRows[0])[5]).toBe("100,00");   // base
    expect(cols(dataRows[0])[7]).toBe("21,00");    // cuota
    // Fila 2: negativa con signo respetado
    expect(cols(dataRows[1])[5]).toBe("-125,00");  // base negativa
    expect(cols(dataRows[1])[7]).toBe("-12,50");   // cuota negativa
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

  it("validates math against sum of vatLines, not flat fields", () => {
    // Suma de bases (50+30+20=100) + cuotas (2+3+4.20=9.20) = 109.20
    // El total declarado coincide -> sin warnings.
    const res = validateForA3Export([
      mkInvoice({
        taxBase: null,
        vatAmount: null,
        totalAmount: 109.20 as any,
        vatLines: [
          { id: "v1", invoiceId: "inv-1", position: 0, taxBase: 50 as any, vatRate: 4 as any, vatAmount: 2 as any, createdAt: new Date() },
          { id: "v2", invoiceId: "inv-1", position: 1, taxBase: 30 as any, vatRate: 10 as any, vatAmount: 3 as any, createdAt: new Date() },
          { id: "v3", invoiceId: "inv-1", position: 2, taxBase: 20 as any, vatRate: 21 as any, vatAmount: 4.20 as any, createdAt: new Date() },
        ] as any,
      }),
    ]);
    expect(res.flatMap((r) => r.warnings).filter((w) => w.includes("Descuadre"))).toEqual([]);
  });
});

describe("validateForA3Export — facturas emitidas y moneda", () => {
  it("en una emitida habla de cuenta cliente e ingreso, no de proveedor y gasto", () => {
    const res = validateForA3Export([
      mkInvoice({ type: "SALE", supplierAccount: null, expenseAccount: null }),
    ]);
    expect(res[0].warnings).toEqual(expect.arrayContaining(["Sin cuenta cliente", "Sin cuenta ingreso"]));
    expect(res[0].warnings).not.toContain("Sin cuenta proveedor");
  });

  it("avisa si los importes no están en euros", () => {
    const res = validateForA3Export([mkInvoice({ currency: "USD" })]);
    expect(res[0].warnings.some((w) => w.includes("USD"))).toBe(true);
  });

  it("no avisa en euros ni cuando la moneda no se detectó", () => {
    const res = validateForA3Export([
      mkInvoice({ currency: "EUR" }),
      mkInvoice({ id: "inv-2", currency: null }),
    ]);
    expect(res.flatMap((r) => r.warnings).filter((w) => w.includes("euros"))).toEqual([]);
  });
});

describe("validateForA3Export — intracomunitarias", () => {
  it("avisa si una compra intracomunitaria (bienes o servicios) declara IVA distinto de 0", () => {
    const bienes = validateForA3Export([
      mkInvoice({ operationType: "INTRACOM" as any, vatAmount: 21 as any }),
    ]);
    const servicios = validateForA3Export([
      mkInvoice({ operationType: "INTRACOM_SERVICIOS" as any, vatAmount: 21 as any }),
    ]);
    expect(bienes[0].warnings.some((w) => w.includes("IVA declarado"))).toBe(true);
    expect(servicios[0].warnings.some((w) => w.includes("IVA declarado"))).toBe(true);
  });

  it("no avisa de IVA si la intracomunitaria ya va a 0%", () => {
    const res = validateForA3Export([
      mkInvoice({
        operationType: "INTRACOM" as any,
        vatAmount: 0 as any,
        totalAmount: 100 as any,
        taxBase: 100 as any,
      }),
    ]);
    expect(res.flatMap((r) => r.warnings).filter((w) => w.includes("IVA declarado"))).toEqual([]);
  });

  it("avisa si una venta intracomunitaria no tiene clasificación bienes/servicios (349)", () => {
    const res = validateForA3Export([
      mkInvoice({
        type: "SALE",
        operationType: "INTRACOM" as any,
        vatAmount: 0 as any,
        totalAmount: 100 as any,
        taxBase: 100 as any,
        intracomGoodsType: null as any,
      }),
    ]);
    expect(res.some((r) => r.warnings.some((w) => w.includes("349")))).toBe(true);
  });

  it("no avisa del 349 si la venta intracomunitaria ya está clasificada", () => {
    const res = validateForA3Export([
      mkInvoice({
        type: "SALE",
        operationType: "INTRACOM" as any,
        vatAmount: 0 as any,
        totalAmount: 100 as any,
        taxBase: 100 as any,
        intracomGoodsType: "BIENES" as any,
      }),
    ]);
    expect(res.flatMap((r) => r.warnings).filter((w) => w.includes("349"))).toEqual([]);
  });

  it("una compra interior normal con IVA no dispara el aviso de intracomunitaria", () => {
    const res = validateForA3Export([mkInvoice({ operationType: "INTERIOR" as any })]);
    expect(res.flatMap((r) => r.warnings).filter((w) => w.includes("IVA declarado"))).toEqual([]);
  });
});

describe("generateA3Excel — recargo de equivalencia", () => {
  function readRows(buf: Buffer, sheetName: string): unknown[][] {
    const wb = XLSX.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
  }

  it("exporta 0/0 en las columnas de recargo cuando la factura no lo lleva", () => {
    const buf = generateA3Excel([mkInvoice()]);
    const rows = readRows(buf, "Facturas recibidas");
    const dataRow = rows[1];
    expect(dataRow[12]).toBe(0); // M: % Rec. Equiv.
    expect(dataRow[13]).toBe(0); // N: Cutoa Rec. Equiv.
  });

  it("exporta el % y la cuota reales cuando la factura sí lleva recargo", () => {
    const buf = generateA3Excel([
      mkInvoice({ equivalenceSurchargeRate: 5.2 as any, equivalenceSurchargeAmount: 5.2 as any }),
    ]);
    const rows = readRows(buf, "Facturas recibidas");
    const dataRow = rows[1];
    expect(dataRow[12]).toBe(5.2);
    expect(dataRow[13]).toBe(5.2);
  });

  it("no aplica el recargo de una factura a otra sin recargo (no queda un valor pegado global)", () => {
    const withSurcharge = mkInvoice({ id: "inv-a", equivalenceSurchargeRate: 5.2 as any, equivalenceSurchargeAmount: 5.2 as any });
    const withoutSurcharge = mkInvoice({ id: "inv-b" });
    const buf = generateA3Excel([withSurcharge, withoutSurcharge]);
    const rows = readRows(buf, "Facturas recibidas");
    expect(rows[1][12]).toBe(5.2);
    expect(rows[2][12]).toBe(0);
  });
});
