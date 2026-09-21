import { describe, it, expect } from "vitest";
import { parseInvoiceNumber, findNumberingGaps } from "@/lib/invoiceNumbering";

describe("parseInvoiceNumber", () => {
  it("separa serie y correlativo en formatos habituales", () => {
    expect(parseInvoiceNumber("2026-045")).toEqual({ series: "2026-", seq: 45 });
    expect(parseInvoiceNumber("FRA0001")).toEqual({ series: "FRA", seq: 1 });
    expect(parseInvoiceNumber("A/123")).toEqual({ series: "A/", seq: 123 });
    expect(parseInvoiceNumber("12")).toEqual({ series: "", seq: 12 });
  });

  it("normaliza la serie a mayusculas", () => {
    expect(parseInvoiceNumber("fra-7")).toEqual({ series: "FRA-", seq: 7 });
  });

  it("devuelve null si no hay ningun digito", () => {
    expect(parseInvoiceNumber("SIN-NUMERO")).toBeNull();
  });
});

describe("findNumberingGaps", () => {
  it("detecta un hueco simple (1, 2, 4 -> falta el 3)", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "1" },
      { id: "b", invoiceNumber: "2" },
      { id: "c", invoiceNumber: "4" },
    ]);
    expect(gaps.get("c")).toEqual([3]);
    expect(gaps.has("a")).toBe(false);
    expect(gaps.has("b")).toBe(false);
  });

  it("no avisa cuando la numeracion es correlativa", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "1" },
      { id: "b", invoiceNumber: "2" },
      { id: "c", invoiceNumber: "3" },
    ]);
    expect(gaps.size).toBe(0);
  });

  it("no avisa con una sola factura", () => {
    expect(findNumberingGaps([{ id: "a", invoiceNumber: "1" }]).size).toBe(0);
  });

  it("ignora facturas sin numero o sin digitos", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "1" },
      { id: "b", invoiceNumber: null },
      { id: "c", invoiceNumber: "SIN-NUMERO" },
      { id: "d", invoiceNumber: "2" },
    ]);
    expect(gaps.size).toBe(0);
  });

  it("no mezcla series distintas", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "A-1" },
      { id: "b", invoiceNumber: "B-1" },
      { id: "c", invoiceNumber: "A-3" },
    ]);
    // A-1 y A-3 son la misma serie (falta el A-2); B-1 va solo en la suya.
    expect(gaps.get("c")).toEqual([2]);
    expect(gaps.size).toBe(1);
  });

  it("ignora saltos enormes (probable serie mal agrupada, no un hueco real)", () => {
    const gaps = findNumberingGaps([
      { id: "a", invoiceNumber: "1" },
      { id: "b", invoiceNumber: "9999" },
    ]);
    expect(gaps.size).toBe(0);
  });
});
