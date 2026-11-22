import { describe, it, expect } from "vitest";
import { planTacoRanges, type TacoRange } from "@/lib/tacoSplitPlan";
import { tacoLotLabel, tacoMarksBar, tacoPagesText, tacoReviewItems, tacoSplitWarnings } from "@/lib/tacoSplitReview";

/** Rangos de facturas con estos números de páginas, seguidas desde la 1. */
function rangesOf(...sizes: number[]): TacoRange[] {
  let start = 1;
  return sizes.map((size) => {
    const range = { start, end: start + size - 1 };
    start += size;
    return range;
  });
}

describe("tacoSplitWarnings (avisos antes de crear las facturas)", () => {
  it("una factura de 11 páginas avisa; una de 10, no", () => {
    expect(tacoSplitWarnings(rangesOf(2, 11, 1))).toEqual(["La factura 2 tiene 11 páginas: ¿seguro que es una sola?"]);
    expect(tacoSplitWarnings(rangesOf(2, 10, 1))).toEqual([]);
  });

  it("todo el PDF en una sola factura (no se ha marcado nada más) avisa", () => {
    expect(tacoSplitWarnings(rangesOf(87))).toEqual(["La factura 1 tiene 87 páginas: ¿seguro que es una sola?"]);
  });

  it("8 facturas de una página de 12 avisa; 3 de 5 no (pocas facturas); 6 de 12 no (no pasa de la mitad)", () => {
    expect(tacoSplitWarnings(rangesOf(1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2))).toEqual([
      "8 facturas de una sola página: ¿seguro que no les falta una hoja?",
    ]);
    expect(tacoSplitWarnings(rangesOf(1, 1, 1, 2, 2))).toEqual([]);
    expect(tacoSplitWarnings(rangesOf(1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2))).toEqual([]);
  });

  it("con 6 facturas, 4 de una página ya avisa; y los dos avisos a la vez", () => {
    expect(tacoSplitWarnings(rangesOf(1, 1, 1, 1, 2, 2))).toEqual(["4 facturas de una sola página: ¿seguro que no les falta una hoja?"]);
    expect(tacoSplitWarnings(rangesOf(1, 1, 1, 1, 1, 12))).toEqual([
      "La factura 6 tiene 12 páginas: ¿seguro que es una sola?",
      "5 facturas de una sola página: ¿seguro que no les falta una hoja?",
    ]);
  });
});

describe("tacoReviewItems (la lista de la revisión)", () => {
  it("las facturas con sus páginas, en singular y plural", () => {
    const plan = planTacoRanges([1, 3, 4, 7], 7);
    if (!plan.ok) throw new Error(plan.error);
    expect(tacoReviewItems(plan.ranges).map((item) => item.text)).toEqual([
      "Factura 1: págs. 1-2",
      "Factura 2: pág. 3",
      "Factura 3: págs. 4-6",
      "Factura 4: pág. 7",
    ]);
  });

  it("si la primera marca no es la 1, delante va lo que no es de ninguna factura", () => {
    const plan = planTacoRanges([3, 5], 7);
    if (!plan.ok) throw new Error(plan.error);
    expect(tacoReviewItems(plan.ranges)).toEqual([
      { kind: "skipped", order: null, range: { start: 1, end: 2 }, text: "Págs. 1-2 · sin factura" },
      { kind: "invoice", order: 1, range: { start: 3, end: 4 }, text: "Factura 1: págs. 3-4" },
      { kind: "invoice", order: 2, range: { start: 5, end: 7 }, text: "Factura 2: págs. 5-7" },
    ]);
    expect(tacoReviewItems([{ start: 2, end: 2 }])[0].text).toBe("Pág. 1 · sin factura");
  });

  it("tacoPagesText", () => {
    expect(tacoPagesText({ start: 27, end: 29 })).toBe("págs. 27-29");
    expect(tacoPagesText({ start: 27, end: 27 })).toBe("pág. 27");
  });
});

describe("tacoMarksBar (la barra de las marcas)", () => {
  it("con más de 300 marcas dice cuántas hay y por qué no se puede revisar, no «0 facturas»", () => {
    const marks = Array.from({ length: 301 }, (_, i) => i + 1);
    expect(tacoMarksBar(marks, planTacoRanges(marks, 450))).toEqual({ invoiceCount: 301, error: "Como mucho 300 facturas por taco." });
    const three = [1, 4, 9];
    expect(tacoMarksBar(three, planTacoRanges(three, 12))).toEqual({ invoiceCount: 3, error: null });
    expect(tacoMarksBar([], planTacoRanges([], 12))).toEqual({ invoiceCount: 0, error: "Marca al menos dónde empieza una factura." });
  });
});

describe("tacoLotLabel", () => {
  it("como en Lotes, y con «Detectar automáticamente», el tipo por detectar", () => {
    expect(tacoLotLabel({ periodType: "MONTHLY", periodMonth: 10, periodYear: 2026, invoiceType: "PURCHASE" })).toBe("Octubre 2026 · Recibidas");
    expect(tacoLotLabel({ periodType: "QUARTERLY", periodMonth: 10, periodYear: 2026, invoiceType: "SALE" })).toBe("T4 2026 · Emitidas");
    expect(tacoLotLabel({ periodType: "MONTHLY", periodMonth: 4, periodYear: 2026, invoiceType: "UNKNOWN" })).toBe("Abril 2026 · tipo por detectar");
  });
});
