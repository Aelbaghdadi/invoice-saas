import { describe, it, expect } from "vitest";
import { hasMoreThanTwoDecimals, percentCents, percentOf, toCents } from "@/lib/money";

describe("toCents", () => {
  it("redondea la mitad lejos del cero, igual en positivo que en negativo", () => {
    expect(toCents(12.105)).toBe(1211);
    expect(toCents(-12.105)).toBe(-1211);
    expect(toCents(12.104)).toBe(1210);
    expect(toCents(-12.104)).toBe(-1210);
    expect(toCents(0)).toBe(0);
  });

  it("sin ruido de coma flotante: 1,005 € son 101 céntimos", () => {
    expect(1.005 * 100).toBeLessThan(100.5); // lo que hace fallar a Math.round
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
});

describe("percentCents / percentOf", () => {
  it("base × % redondeado a céntimos, lejos del cero", () => {
    expect(percentCents(100, 21)).toBe(2100);
    expect(percentCents(33.33, 21)).toBe(700); // 6,9993
    expect(percentCents(2.5, 21)).toBe(53); // 0,525
    expect(percentCents(-2.5, 21)).toBe(-53);
    expect(percentOf(100.3, 15)).toBe(15.05); // 15,045: toFixed daba 15,04
  });
});

describe("hasMoreThanTwoDecimals", () => {
  it("importes altos: la tolerancia es relativa (antes fallaba a partir de ~134 M€)", () => {
    expect(hasMoreThanTwoDecimals(134218247.52)).toBe(false);
    expect(hasMoreThanTwoDecimals(9999999999.99)).toBe(false);
    expect(hasMoreThanTwoDecimals(-9999999999.99)).toBe(false);
    expect(hasMoreThanTwoDecimals(1.005)).toBe(true);
    expect(toCents(134218247.52)).toBe(13421824752);
    expect(toCents(9999999999.99)).toBe(999999999999);
  });

  it("1,005 sí; 1,5, 15,05 y 100 no", () => {
    expect(hasMoreThanTwoDecimals(1.005)).toBe(true);
    expect(hasMoreThanTwoDecimals(-0.001)).toBe(true);
    for (const n of [1.5, 15.05, 100, -12.11, 0.29]) expect(hasMoreThanTwoDecimals(n)).toBe(false);
  });
});
