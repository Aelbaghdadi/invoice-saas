import { describe, it, expect } from "vitest";
import { parseArchiveQuery } from "@/lib/archiveSearchQuery";
import { matchesSearch } from "@/lib/listing";

const NO_PAPER = { taco: null, box: null };

describe("parseArchiveQuery", () => {
  it("nº de registro con letra: se busca como tal y también como texto", () => {
    expect(parseArchiveQuery("R-2026/153")).toEqual({
      kind: "registro",
      text: "R-2026/153",
      register: { type: "PURCHASE", year: 2026, number: 153 },
      amount: null,
      ...NO_PAPER,
    });
    expect(parseArchiveQuery("  e2025/7 ")).toEqual({
      kind: "registro",
      text: "e2025/7",
      register: { type: "SALE", year: 2025, number: 7 },
      amount: null,
      ...NO_PAPER,
    });
  });

  it("sin letra vale para las dos series, y el texto sigue ahí: puede ser un nº de factura", () => {
    const query = parseArchiveQuery("2026/153");
    expect(query).toEqual({ kind: "registro", text: "2026/153", register: { type: null, year: 2026, number: 153 }, amount: null, ...NO_PAPER });
    expect(matchesSearch(["FRA 2026/153"], query.text)).toBe(true);
  });

  it("T37, taco 37 y caja 3 se reconocen y siguen siendo texto", () => {
    expect(parseArchiveQuery("T37")).toEqual({ kind: "texto", text: "T37", amount: null, taco: { number: 37, page: null }, box: null });
    expect(parseArchiveQuery("taco 37")).toEqual({ kind: "texto", text: "taco 37", amount: null, taco: { number: 37, page: null }, box: null });
    expect(parseArchiveQuery("caja 3")).toEqual({ kind: "texto", text: "caja 3", amount: null, taco: null, box: { number: 3 } });
  });

  it("el taco, escrito de varias maneras", () => {
    for (const text of ["T37", "t 37", "taco 37", "Taco nº 37", "TACO Nº37", "taco n° 37", "taco no. 37", "T-37", "Taco n.º 37", "taco n. º 37", "Taco núm. 37", "taco numero 37"]) {
      expect(parseArchiveQuery(text).taco, text).toEqual({ number: 37, page: null });
    }
  });

  it("el taco con su página, también como sale en la tabla", () => {
    for (const text of [
      "T37 pág 28",
      "taco 37 pag. 28",
      "T37/28",
      "T37 / 28",
      "T37 p28",
      "t37 p. 28",
      "Taco 37 página 28",
      "T37 · Pág. 28",
      "Taco 37 · Pág. 28 del PDF",
    ]) {
      expect(parseArchiveQuery(text).taco, text).toEqual({ number: 37, page: 28 });
    }
  });

  it("la ubicación copiada de la tabla o de la ficha, con la caja o la fecha delante y la nota detrás", () => {
    for (const text of [
      "Caja 3 · T37 · Pág. 28",
      "Panadería López · 2026 · Caja 3 · Taco 37 · Pág. 28",
      "Caja 3 · T37 · Pág. 28 del PDF",
      "T2 archivo · Taco 37 · Pág. 28",
      "Devuelto al cliente el 21/11/2026 · T37 · Pág. 28",
      "T37 · Pág. 28 (sin guardar)",
      "Taco 37 · Pág. 28 (taco anulado)",
    ]) {
      const query = parseArchiveQuery(text);
      expect(query.taco, text).toEqual({ number: 37, page: 28 });
      expect(query.box, text).toBeNull();
    }
    expect(parseArchiveQuery("Caja 3 · Taco 37").taco).toEqual({ number: 37, page: null });
    // Sin taco, sigue siendo solo texto.
    for (const text of ["Caja 3 · papel ubicado a mano", "Panadería López · 2026 · Caja 3", "Caja 3 · T37 28", "Caja 3 · Tarragona 37"]) {
      expect(parseArchiveQuery(text).taco, text).toBeNull();
    }
  });

  it("la caja", () => {
    for (const text of ["caja 3", "Caja nº 3", "CAJA 3", "caja n° 3", "Caja3", "Caja n.º 3", "Caja núm. 3", "caja número 3"]) {
      const query = parseArchiveQuery(text);
      expect(query.box, text).toEqual({ number: 3 });
      expect(query.taco, text).toBeNull();
    }
  });

  it("lo que no es ni taco ni caja", () => {
    for (const text of ["T", "taco", "37", "T37abc", "2026/153", "T37 28", "Tarragona 37", "caja", "caja 3 López", "T0", "T37/0", "caja 0"]) {
      const query = parseArchiveQuery(text);
      expect([query.taco, query.box], text).toEqual([null, null]);
    }
  });

  it("el texto con tildes se conserva tal cual y casa sin tildes", () => {
    const query = parseArchiveQuery("Cárnicas   Ñoño");
    expect(query).toEqual({ kind: "texto", text: "Cárnicas Ñoño", amount: null, ...NO_PAPER });
    expect(matchesSearch(["CARNICAS NOÑO, S.L."], query.text)).toBe(true);
  });

  it("los importes, como se teclean o como salen impresos", () => {
    expect(parseArchiveQuery("1134,6")).toEqual({ kind: "texto", text: "1134,6", amount: 1134.6, ...NO_PAPER });
    expect(parseArchiveQuery("1.134,60")).toEqual({ kind: "texto", text: "1.134,60", amount: 1134.6, ...NO_PAPER });
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
    expect(parseArchiveQuery("   ")).toEqual({ kind: "texto", text: "", amount: null, ...NO_PAPER });
    expect(parseArchiveQuery(null)).toEqual({ kind: "texto", text: "", amount: null, ...NO_PAPER });
  });
});
