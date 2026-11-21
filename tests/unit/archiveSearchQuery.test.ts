import { describe, it, expect } from "vitest";
import { parseArchiveQuery } from "@/lib/archiveSearchQuery";
import { matchesSearch } from "@/lib/listing";

describe("parseArchiveQuery", () => {
  it("nº de registro con letra: se busca como tal y también como texto", () => {
    expect(parseArchiveQuery("R-2026/153")).toEqual({
      kind: "registro",
      text: "R-2026/153",
      register: { type: "PURCHASE", year: 2026, number: 153 },
      amount: null,
    });
    expect(parseArchiveQuery("  e2025/7 ")).toEqual({
      kind: "registro",
      text: "e2025/7",
      register: { type: "SALE", year: 2025, number: 7 },
      amount: null,
    });
  });

  it("sin letra vale para las dos series, y el texto sigue ahí: puede ser un nº de factura", () => {
    const query = parseArchiveQuery("2026/153");
    expect(query).toEqual({ kind: "registro", text: "2026/153", register: { type: null, year: 2026, number: 153 }, amount: null });
    expect(matchesSearch(["FRA 2026/153"], query.text)).toBe(true);
  });

  it("taco y caja aún no se interpretan: son texto", () => {
    for (const text of ["T37", "taco 37", "caja 3"]) {
      expect(parseArchiveQuery(text), text).toEqual({ kind: "texto", text, amount: null });
    }
  });

  it("el texto con tildes se conserva tal cual y casa sin tildes", () => {
    const query = parseArchiveQuery("Cárnicas   Ñoño");
    expect(query).toEqual({ kind: "texto", text: "Cárnicas Ñoño", amount: null });
    expect(matchesSearch(["CARNICAS NOÑO, S.L."], query.text)).toBe(true);
  });

  it("los importes, como se teclean o como salen impresos", () => {
    expect(parseArchiveQuery("1134,6")).toEqual({ kind: "texto", text: "1134,6", amount: 1134.6 });
    expect(parseArchiveQuery("1.134,60")).toEqual({ kind: "texto", text: "1.134,60", amount: 1134.6 });
    expect(parseArchiveQuery("1.134,60 €").amount).toBe(1134.6);
    expect(parseArchiveQuery("1134.60").amount).toBe(1134.6);
    expect(parseArchiveQuery("1.234.567,89").amount).toBe(1234567.89);
    expect(parseArchiveQuery("-21,00").amount).toBe(-21);
  });

  it("un número suelto, una fecha o un teléfono no son importes", () => {
    for (const text of ["1134", "2026", "14.09.2026", "91.123.45.67", "B12345674", "R-2026/153"]) {
      expect(parseArchiveQuery(text).amount, text).toBeNull();
    }
  });

  it("sin nada tecleado, texto vacío", () => {
    expect(parseArchiveQuery("   ")).toEqual({ kind: "texto", text: "", amount: null });
    expect(parseArchiveQuery(null)).toEqual({ kind: "texto", text: "", amount: null });
  });
});
