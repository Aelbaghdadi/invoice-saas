import { describe, it, expect } from "vitest";
import {
  defaultSortDir,
  invoiceRowComparator,
  nextSortDir,
  parseInvoiceSortKey,
  thirdPartyName,
  type InvoiceSortRow,
} from "@/lib/invoiceSort";

const row = (id: string, over: Partial<InvoiceSortRow> = {}): InvoiceSortRow =>
  ({ id, type: "PURCHASE", issuerName: null, receiverName: null, register: null, ...over });
const ids = (rows: InvoiceSortRow[]) => rows.map((r) => r.id);

describe("parseInvoiceSortKey y sentido", () => {
  it("lo que no es una columna conocida es la fecha de subida", () => {
    expect(parseInvoiceSortKey("proveedor")).toBe("proveedor");
    expect(parseInvoiceSortKey("fechafactura")).toBe("fechafactura");
    expect(parseInvoiceSortKey("DROP TABLE")).toBe("fecha");
    expect(parseInvoiceSortKey(undefined)).toBe("fecha");
  });

  it("fechas e importes empiezan por lo más reciente; el resto, de la A a la Z", () => {
    expect(defaultSortDir("fechafactura")).toBe("desc");
    expect(defaultSortDir("total")).toBe("desc");
    expect(defaultSortDir("proveedor")).toBe("asc");
    expect(defaultSortDir("registro")).toBe("asc");
  });

  it("pulsar la columna activa invierte el sentido", () => {
    expect(nextSortDir("proveedor", "asc", "proveedor")).toBe("desc");
    expect(nextSortDir("proveedor", "desc", "proveedor")).toBe("asc");
    expect(nextSortDir("fecha", "desc", "proveedor")).toBe("asc");
  });
});

describe("thirdPartyName", () => {
  it("el emisor en recibidas y el receptor en emitidas", () => {
    expect(thirdPartyName({ type: "PURCHASE", issuerName: "Proveedor SL", receiverName: "Cliente SL" })).toBe("Proveedor SL");
    expect(thirdPartyName({ type: "SALE", issuerName: "Cliente SL", receiverName: "Comprador SA" })).toBe("Comprador SA");
    expect(thirdPartyName({ type: "SALE", issuerName: "Cliente SL", receiverName: "  " })).toBeNull();
  });
});

describe("orden por proveedor", () => {
  const rows = [
    row("1", { issuerName: "Zapatería Pérez" }),
    row("2", { type: "SALE", issuerName: "Cliente SL", receiverName: "Ábaco Formación" }),
    row("3", { issuerName: null }),
    row("4", { issuerName: "acme" }),
    row("5", { issuerName: "Proveedor 10" }),
    row("6", { issuerName: "Proveedor 2" }),
  ];

  it("de la A a la Z por el tercero, sin tildes ni mayúsculas, números en orden natural y sin nombre al final", () => {
    expect(ids([...rows].sort(invoiceRowComparator("proveedor", "asc")))).toEqual(["2", "4", "6", "5", "1", "3"]);
  });

  it("de la Z a la A, las que no tienen nombre siguen al final", () => {
    expect(ids([...rows].sort(invoiceRowComparator("proveedor", "desc")))).toEqual(["1", "5", "6", "4", "2", "3"]);
  });

  it("con el mismo nombre desempata el id, para que la página no cambie", () => {
    const same = [row("b", { issuerName: "Acme" }), row("a", { issuerName: "ACME" })];
    expect(ids(same.sort(invoiceRowComparator("proveedor", "desc")))).toEqual(["a", "b"]);
  });
});

describe("orden por nº de registro", () => {
  const rows = [
    row("e1", { register: { type: "SALE", year: 2026, number: 1 } }),
    row("r10", { register: { type: "PURCHASE", year: 2026, number: 10 } }),
    row("sin", {}),
    row("r2", { register: { type: "PURCHASE", year: 2026, number: 2 } }),
    row("r25", { register: { type: "PURCHASE", year: 2025, number: 99 } }),
  ];

  it("por año, la serie R antes que la E y el número; sin registrar al final", () => {
    expect(ids([...rows].sort(invoiceRowComparator("registro", "asc")))).toEqual(["r25", "r2", "r10", "e1", "sin"]);
  });

  it("al revés, las que no tienen número siguen al final", () => {
    expect(ids([...rows].sort(invoiceRowComparator("registro", "desc")))).toEqual(["e1", "r10", "r2", "r25", "sin"]);
  });
});
