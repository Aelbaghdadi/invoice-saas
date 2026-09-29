import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  parsePage,
  pageWindow,
  normalizeSearch,
  matchesSearch,
  periodMonthFilter,
  parseIntInRange,
} from "@/lib/listing";

describe("parsePage", () => {
  it("lee la pagina de la URL", () => {
    expect(parsePage("3")).toBe(3);
  });

  it("cualquier cosa rara es la primera", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-2")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });
});

describe("pageWindow", () => {
  it("calcula la ventana de una pagina intermedia", () => {
    expect(pageWindow(2, 212, 25)).toEqual({
      page: 2, totalPages: 9, skip: 25, take: 25, from: 26, to: 50, total: 212,
    });
  });

  it("la ultima pagina acaba en el total", () => {
    const w = pageWindow(9, 212, 25);
    expect(w.from).toBe(201);
    expect(w.to).toBe(212);
  });

  it("una pagina que ya no existe ensena la ultima, no una tabla vacia", () => {
    // Se filtro y quedaron menos filas de las que habia al pedir la pagina 9.
    expect(pageWindow(9, 30, 25).page).toBe(2);
  });

  it("sin filas no revienta", () => {
    expect(pageWindow(1, 0)).toEqual({
      page: 1, totalPages: 1, skip: 0, take: PAGE_SIZE, from: 0, to: 0, total: 0,
    });
  });
});

describe("normalizeSearch / matchesSearch", () => {
  it("quita tildes, mayusculas y espacios sobrantes", () => {
    expect(normalizeSearch("  Cárnicas   JOSELITO ")).toBe("carnicas joselito");
  });

  it("\"carnicas\" encuentra \"Cárnicas Joselito\"", () => {
    expect(matchesSearch(["Cárnicas Joselito SL"], "carnicas")).toBe(true);
  });

  it("un numero pegado desde A3 con espacio final se encuentra igual", () => {
    expect(matchesSearch(["M-2604525"], "M-2604525 ")).toBe(true);
  });

  it("busca en cualquiera de los campos y tolera los nulos", () => {
    expect(matchesSearch([null, undefined, "B65638736"], "b6563")).toBe(true);
  });

  it("sin texto, todo vale", () => {
    expect(matchesSearch(["lo que sea"], "   ")).toBe(true);
  });

  it("si no esta en ningun campo, no", () => {
    expect(matchesSearch(["Nordwerk Software GmbH", "RE-2026-4520"], "galma")).toBe(false);
  });
});

describe("periodMonthFilter", () => {
  it("un trimestre son sus tres meses", () => {
    expect(periodMonthFilter(undefined, 3)).toEqual({ gte: 7, lte: 9 });
    expect(periodMonthFilter(undefined, 1)).toEqual({ gte: 1, lte: 3 });
  });

  it("el trimestre manda sobre el mes", () => {
    expect(periodMonthFilter(2, 4)).toEqual({ gte: 10, lte: 12 });
  });

  it("un mes suelto es ese mes", () => {
    expect(periodMonthFilter(7, undefined)).toBe(7);
  });

  it("valores fuera de rango no filtran", () => {
    expect(periodMonthFilter(13, 5)).toBeUndefined();
    expect(periodMonthFilter(undefined, undefined)).toBeUndefined();
  });
});

describe("parseIntInRange", () => {
  it("acepta lo que cae dentro y rechaza lo demas", () => {
    expect(parseIntInRange("2026", 2000, 2100)).toBe(2026);
    expect(parseIntInRange("1999", 2000, 2100)).toBeUndefined();
    expect(parseIntInRange("x", 1, 12)).toBeUndefined();
    expect(parseIntInRange(undefined, 1, 12)).toBeUndefined();
  });
});
