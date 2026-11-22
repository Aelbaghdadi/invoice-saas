// La pestaña Tacos en la URL (5.6) y los textos de la cabecera de un taco
// (5.7, 5.14), sin BD.
import { describe, it, expect } from "vitest";
import { parseTacoListParams, tacosHref } from "@/lib/tacoListParams";
import { tacoCountsLine, tacoDetailTitle } from "@/lib/tacoDetailText";
import type { TacoDetail } from "@/lib/tacoData";

describe("filtros de la pestaña Tacos", () => {
  it("lee la URL; lo que no entiende es «todos»", () => {
    expect(parseTacoListParams({})).toEqual({ estado: "todos", clientId: null, year: null, caja: "", page: 1 });
    expect(parseTacoListParams({ estado: "sin-guardar", cliente: "varios", year: "2026", caja: "  Caja 3 ", page: "2" }))
      .toEqual({ estado: "sin-guardar", clientId: "varios", year: 2026, caja: "Caja 3", page: 2 });
    expect(parseTacoListParams({ estado: "otro", year: "26", page: "-3" })).toMatchObject({ estado: "todos", year: null, page: 1 });
    // Repetido en la URL, vale el primero.
    expect(parseTacoListParams({ estado: ["anulados", "todos"], caja: ["a", "b"] })).toMatchObject({ estado: "anulados", caja: "a" });
  });

  it("el enlace solo lleva lo que no es por defecto, y se lee igual", () => {
    expect(tacosHref({})).toBe("/dashboard/archivo/tacos");
    expect(tacosHref({ estado: "todos", page: 1 })).toBe("/dashboard/archivo/tacos");
    const href = tacosHref({ estado: "por-dividir", clientId: "c1", year: 2026, caja: "López", page: 3 });
    expect(href).toBe("/dashboard/archivo/tacos?estado=por-dividir&cliente=c1&year=2026&caja=L%C3%B3pez&page=3");
    expect(parseTacoListParams(Object.fromEntries(new URL(href, "http://x").searchParams)))
      .toEqual({ estado: "por-dividir", clientId: "c1", year: 2026, caja: "López", page: 3 });
  });
});

type Slot = TacoDetail["slots"][number];
const slot = (page: number, kind: Slot["kind"], order: number | null = null, endPage = page): Slot =>
  ({ page, endPage, order, kind, rows: [], label: null });

describe("cabecera de un taco", () => {
  const base = { kind: "taco" as const, fileCount: 0, rows: [], wholePdf: false, pdfPageCount: null, split: false, slots: [] as Slot[] };

  it("el título según la clase de tanda", () => {
    expect(tacoDetailTitle({ kind: "taco", tacoNumber: 37 })).toBe("Taco 37");
    expect(tacoDetailTitle({ kind: "archive", tacoNumber: 40 })).toBe("Taco 40 · papel ubicado a mano");
    expect(tacoDetailTitle({ kind: "digital", tacoNumber: null })).toBe("Tanda digital");
  });

  it("las cuentas: páginas con y sin factura, el taco entero y la tanda digital", () => {
    expect(tacoCountsLine({ ...base, fileCount: 3, slots: [slot(1, "invoices"), slot(2, "empty"), slot(3, "electronic")] }))
      .toBe("3 páginas · 2 con factura · 1 sin factura");
    expect(tacoCountsLine({ ...base, fileCount: 1, slots: [slot(1, "invoices")] })).toBe("1 página · 1 con factura");
    expect(tacoCountsLine({ ...base, wholePdf: true, pdfPageCount: 87 })).toBe("87 páginas del PDF · sin dividir");
    expect(tacoCountsLine({
      ...base, wholePdf: true, split: true, pdfPageCount: 12,
      slots: [slot(1, "empty", null, 2), slot(3, "invoices", 1, 4), slot(5, "invoices", 2, 12)],
    })).toBe("12 páginas del PDF · 2 facturas");
    expect(tacoCountsLine({ ...base, kind: "digital", fileCount: 12 })).toBe("12 ficheros");
  });
});
