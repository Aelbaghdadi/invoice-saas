import { describe, it, expect } from "vitest";
import {
  MAX_IDS_IN_QUERY,
  amountSearchVariants,
  countStatusesMatching,
  inMemoryIdFilter,
  pageOfMatching,
} from "@/lib/invoiceSearch";
import { matchesSearch, pageWindow } from "@/lib/listing";

describe("amountSearchVariants", () => {
  it("encuentra el importe como se teclea", () => {
    const variants = amountSearchVariants(1134.6);
    expect(matchesSearch(variants, "1134,6")).toBe(true);
    expect(matchesSearch(variants, "1134.60")).toBe(true);
    expect(matchesSearch(variants, "1134,60")).toBe(true);
  });

  it("encuentra el importe como lo pinta la tabla, con punto de miles", () => {
    const variants = amountSearchVariants(12345.6);
    expect(matchesSearch(variants, "12.345,60")).toBe(true);
    // Copiado de la celda, con el simbolo (y el espacio que ponga el navegador).
    expect(matchesSearch(variants, "12.345,60 €")).toBe(true);
    expect(matchesSearch(variants, "12.345,60 €")).toBe(true);
    expect(matchesSearch(variants, "1.234.567,89")).toBe(false);
    expect(matchesSearch(amountSearchVariants(1234567.89), "1.234.567,89")).toBe(true);
  });

  it("sin importe no aporta nada que buscar", () => {
    expect(amountSearchVariants(null)).toEqual([]);
  });
});

describe("inMemoryIdFilter", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);

  it("sin texto, o con pocos ids, se filtra en la BD", () => {
    expect(inMemoryIdFilter(null)).toBeNull();
    expect(inMemoryIdFilter([])).toBeNull();
    expect(inMemoryIdFilter(ids(MAX_IDS_IN_QUERY))).toBeNull();
  });

  it("pasado el umbral devuelve el Set para filtrar en memoria", () => {
    const set = inMemoryIdFilter(ids(MAX_IDS_IN_QUERY + 1));
    expect(set).toBeInstanceOf(Set);
    expect(set?.size).toBe(MAX_IDS_IN_QUERY + 1);
  });

  it("el umbral queda muy por debajo del limite de parametros de node-postgres", () => {
    expect(MAX_IDS_IN_QUERY).toBeLessThan(65_535);
  });
});

describe("pageOfMatching", () => {
  // Lo que haria la BD con `id IN (...)` + ORDER BY + OFFSET/LIMIT.
  function viaIn(ordered: string[], matching: Set<string>, page: number, pageSize?: number) {
    const filtered = ordered.filter((id) => matching.has(id));
    const window = pageWindow(page, filtered.length, pageSize);
    return { ids: filtered.slice(window.skip, window.skip + window.take), window };
  }

  // Mas ids que el umbral, en un orden que no es el alfabetico: el de la BD
  // tiene que mantenerse tal cual.
  const ordered = Array.from({ length: 25_000 }, (_, i) => `inv-${(i * 7919) % 25_000}`);
  const matching = new Set(ordered.filter((_, i) => i % 2 === 0 || i % 5 === 0));

  it("da lo mismo que el camino con IN en la primera, una intermedia y la ultima pagina", () => {
    expect(matching.size).toBeGreaterThan(MAX_IDS_IN_QUERY);
    for (const page of [1, 2, 137, 600]) {
      expect(pageOfMatching(ordered, matching, page)).toEqual(viaIn(ordered, matching, page));
    }
  });

  it("una pagina que ya no existe ensena la ultima, igual que en la BD", () => {
    const res = pageOfMatching(ordered, matching, 99_999);
    expect(res.window.page).toBe(res.window.totalPages);
    expect(res).toEqual(viaIn(ordered, matching, 99_999));
  });

  it("respeta el orden de la BD y el tamaño de pagina", () => {
    const res = pageOfMatching(["c", "a", "d", "b", "e"], new Set(["e", "a", "b"]), 1, 2);
    expect(res.ids).toEqual(["a", "b"]);
    expect(res.window.total).toBe(3);
    expect(res.window.totalPages).toBe(2);
  });

  it("sin coincidencias, pagina vacia con total 0", () => {
    const res = pageOfMatching(["a", "b"], new Set(["z"]), 1);
    expect(res.ids).toEqual([]);
    expect(res.window.total).toBe(0);
    expect(res.window.page).toBe(1);
  });
});

describe("countStatusesMatching", () => {
  it("cuenta por estado solo las que casan", () => {
    const rows = [
      { id: "1", status: "PENDING_REVIEW" },
      { id: "2", status: "PENDING_REVIEW" },
      { id: "3", status: "OCR_ERROR" },
      { id: "4", status: "VALIDATED" },
    ] as const;
    expect(countStatusesMatching(rows, new Set(["1", "3", "4", "otro"]))).toEqual({
      PENDING_REVIEW: 1,
      OCR_ERROR: 1,
      VALIDATED: 1,
    });
  });

  it("sin coincidencias no hay estados", () => {
    expect(countStatusesMatching([{ id: "1", status: "VALIDATED" }], new Set())).toEqual({});
  });
});
