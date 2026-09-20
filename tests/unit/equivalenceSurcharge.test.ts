import { describe, it, expect } from "vitest";
import {
  foldSurchargeLines,
  completeReadSurcharges,
  proposeSurchargesFromTotal,
  isSurchargeRate,
  isStandardVatRate,
  surchargeAuditValue,
} from "@/lib/equivalenceSurcharge";

const line = (
  taxBase: number,
  vatRate: number,
  vatAmount: number,
  rate: number | null = null,
  amount: number | null = null,
) => ({ taxBase, vatRate, vatAmount, equivalenceSurchargeRate: rate, equivalenceSurchargeAmount: amount });

describe("tipos", () => {
  it("distingue tipos de recargo de tipos de IVA", () => {
    expect(isSurchargeRate(5.2)).toBe(true);
    expect(isSurchargeRate(1.4)).toBe(true);
    expect(isSurchargeRate(0.5)).toBe(true);
    expect(isSurchargeRate(21)).toBe(false);
    expect(isStandardVatRate(21)).toBe(true);
    expect(isStandardVatRate(0)).toBe(true);
    expect(isStandardVatRate(5.2)).toBe(false);
  });
});

describe("foldSurchargeLines — el recargo colado como línea de IVA", () => {
  it("cuota en el IVA y base 0 (caso F261238)", () => {
    const { lines, plegadas, huerfanas } = foldSurchargeLines([
      line(286.63, 21, 60.19),
      line(0, 5.2, 14.90),
    ]);
    expect(plegadas).toBe(1);
    expect(huerfanas).toBe(0);
    expect(lines).toEqual([line(286.63, 21, 60.19, 5.2, 14.90)]);
  });

  it("importe en la base y cuota 0 (caso F261208)", () => {
    const { lines } = foldSurchargeLines([
      line(250.79, 21, 52.67),
      line(13.04, 5.2, 0),
    ]);
    expect(lines).toEqual([line(250.79, 21, 52.67, 5.2, 13.04)]);
  });

  it("recargo ya bien puesto y además repetido como línea falsa: se queda uno (caso F261278)", () => {
    const { lines, plegadas } = foldSurchargeLines([
      line(247.74, 21, 52.02, 5.2, 12.88),
      line(0, 5.2, 12.88),
    ]);
    expect(plegadas).toBe(1);
    expect(lines).toEqual([line(247.74, 21, 52.02, 5.2, 12.88)]);
  });

  it("cada tipo va a su línea: 1,4 al 10 % y 5,2 al 21 %", () => {
    const { lines } = foldSurchargeLines([
      line(100, 21, 21),
      line(200, 10, 20),
      line(0, 1.4, 2.80),
      line(0, 5.2, 5.20),
    ]);
    expect(lines).toEqual([
      line(100, 21, 21, 5.2, 5.20),
      line(200, 10, 20, 1.4, 2.80),
    ]);
  });

  it("sin línea de IVA a la que pertenecer, no se pierde el importe", () => {
    const { lines, huerfanas } = foldSurchargeLines([line(0, 5.2, 10)]);
    expect(huerfanas).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it("una factura normal no se toca", () => {
    const original = [line(100, 21, 21), line(50, 10, 5)];
    const { lines, plegadas } = foldSurchargeLines(original);
    expect(plegadas).toBe(0);
    expect(lines).toEqual(original);
  });
});

describe("completeReadSurcharges — la IA leyó solo la mitad", () => {
  it("con el % calcula la cuota", () => {
    expect(completeReadSurcharges([line(100, 21, 21, 5.2, null)])[0].equivalenceSurchargeAmount).toBe(5.2);
  });

  it("con la cuota leída deduce el % y NO pisa el importe del documento", () => {
    const [l] = completeReadSurcharges([line(526.03, 21, 110.45, null, 27.37)]);
    expect(l.equivalenceSurchargeRate).toBe(5.2);
    expect(l.equivalenceSurchargeAmount).toBe(27.37);
  });

  it("sin recargo no inventa nada", () => {
    expect(completeReadSurcharges([line(100, 21, 21)])[0].equivalenceSurchargeRate).toBeNull();
  });
});

describe("proposeSurchargesFromTotal — solo si explica el descuadre", () => {
  it("cuadra con el total impreso aunque el proveedor redondee distinto (caso F261064)", () => {
    const p = proposeSurchargesFromTotal([line(526.03, 21, 110.45)], 663.85, null);
    expect(p).toEqual([{ index: 0, rate: 5.2, amount: 27.37 }]);
  });

  it("no le pone recargo a los portes: elige solo la línea que cuadra", () => {
    const lines = [line(1000, 21, 210), line(30, 21, 6.3)];
    const p = proposeSurchargesFromTotal(lines, 1298.30, null);
    expect(p).toEqual([{ index: 0, rate: 5.2, amount: 52 }]);
  });

  it("si la factura ya cuadra sin recargo, no propone nada", () => {
    expect(proposeSurchargesFromTotal([line(100, 21, 21)], 121, null)).toEqual([]);
  });

  it("si el recargo no explica la diferencia, no inventa nada", () => {
    expect(proposeSurchargesFromTotal([line(100, 21, 21)], 221, null)).toEqual([]);
  });

  it("respeta el signo en una rectificativa", () => {
    const p = proposeSurchargesFromTotal([line(-1000, 21, -210)], -1262, null);
    expect(p).toEqual([{ index: 0, rate: 5.2, amount: -52 }]);
  });

  it("no toca las líneas que ya llevan recargo leído", () => {
    const lines = [line(100, 21, 21, 5.2, 5.2), line(200, 10, 20)];
    const p = proposeSurchargesFromTotal(lines, 349, null);
    expect(p).toEqual([{ index: 1, rate: 1.4, amount: 2.8 }]);
  });

  it("descuenta la retención al calcular lo que falta", () => {
    const p = proposeSurchargesFromTotal([line(1000, 21, 210)], 1112, 150);
    expect(p).toEqual([{ index: 0, rate: 5.2, amount: 52 }]);
  });
});

describe("surchargeAuditValue", () => {
  it("resume el recargo por línea", () => {
    expect(surchargeAuditValue([line(100, 21, 21, 5.2, 5.2), line(50, 10, 5)])).toBe("21%: 5.2% 5.2");
  });

  it("sin recargo devuelve null", () => {
    expect(surchargeAuditValue([line(100, 21, 21)])).toBeNull();
  });
});
