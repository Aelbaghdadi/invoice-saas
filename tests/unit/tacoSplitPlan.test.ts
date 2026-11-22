import { describe, it, expect } from "vitest";
import { planTacoRanges, TACO_PDF_MAX_PAGES, TACO_SPLIT_MAX_PARTS } from "@/lib/tacoSplitPlan";

describe("planTacoRanges (rangos de un taco entero)", () => {
  it("cada factura llega hasta la página anterior a la siguiente marca, y la última hasta el final", () => {
    expect(planTacoRanges([1, 3, 4, 7], 7)).toEqual({
      ok: true,
      ranges: [{ start: 1, end: 2 }, { start: 3, end: 3 }, { start: 4, end: 6 }, { start: 7, end: 7 }],
    });
  });

  it("la primera marca puede no ser la 1: lo de antes no es de ninguna factura", () => {
    expect(planTacoRanges([2, 5], 7)).toEqual({ ok: true, ranges: [{ start: 2, end: 4 }, { start: 5, end: 7 }] });
  });

  it("ordena las marcas y quita las repetidas", () => {
    expect(planTacoRanges([5, 2, 5, 2], 7)).toEqual({ ok: true, ranges: [{ start: 2, end: 4 }, { start: 5, end: 7 }] });
  });

  it("sin marcas", () => {
    expect(planTacoRanges([], 7)).toEqual({ ok: false, error: "Marca al menos dónde empieza una factura." });
  });

  it("una página que no existe", () => {
    expect(planTacoRanges([1, 90], 87)).toEqual({ ok: false, error: "La página 90 no existe: el PDF tiene 87 páginas." });
    expect(planTacoRanges([0, 3], 87)).toEqual({ ok: false, error: "La página 0 no existe: el PDF tiene 87 páginas." });
    expect(planTacoRanges([2], 1)).toEqual({ ok: false, error: "La página 2 no existe: el PDF tiene 1 página." });
  });

  it("marcas que no son números enteros", () => {
    const wrong = { ok: false, error: "Las marcas no valen. Recarga la página." };
    expect(planTacoRanges([1, 2.5], 7)).toEqual(wrong);
    expect(planTacoRanges([1, Number.NaN], 7)).toEqual(wrong);
    expect(planTacoRanges([1], 0)).toEqual(wrong);
  });

  it(`como mucho ${TACO_SPLIT_MAX_PARTS} facturas`, () => {
    const pages = Array.from({ length: TACO_SPLIT_MAX_PARTS + 1 }, (_, i) => i + 1);
    expect(planTacoRanges(pages, TACO_PDF_MAX_PAGES)).toEqual({ ok: false, error: "Como mucho 300 facturas por taco." });
    const ok = planTacoRanges(pages.slice(0, TACO_SPLIT_MAX_PARTS), TACO_PDF_MAX_PAGES);
    expect(ok.ok && ok.ranges.length).toBe(TACO_SPLIT_MAX_PARTS);
    expect(ok.ok && ok.ranges.at(-1)).toEqual({ start: 300, end: 500 });
  });
});
