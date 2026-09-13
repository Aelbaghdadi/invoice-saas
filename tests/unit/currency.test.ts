import { describe, it, expect } from "vitest";
import { normalizeCurrency, isForeignCurrency } from "@/lib/currency";

describe("normalizeCurrency", () => {
  it("acepta códigos ISO en cualquier caja y con espacios", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency(" EUR ")).toBe("EUR");
    expect(normalizeCurrency("DKK")).toBe("DKK");
  });

  it("traduce los símbolos", () => {
    expect(normalizeCurrency("€")).toBe("EUR");
    expect(normalizeCurrency("£")).toBe("GBP");
    expect(normalizeCurrency("$")).toBe("USD");
  });

  it("no convierte en moneda un trío de letras cualquiera", () => {
    expect(normalizeCurrency("IVA")).toBeNull();
    expect(normalizeCurrency("NIF")).toBeNull();
  });

  it("devuelve null con valores vacíos o que no son texto", () => {
    expect(normalizeCurrency("")).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
    expect(normalizeCurrency(978)).toBeNull();
  });
});

describe("isForeignCurrency", () => {
  it("el euro y la moneda no detectada no cuentan como extranjeras", () => {
    expect(isForeignCurrency("EUR")).toBe(false);
    expect(isForeignCurrency(null)).toBe(false);
    expect(isForeignCurrency(undefined)).toBe(false);
    expect(isForeignCurrency("")).toBe(false);
  });

  it("cualquier otra moneda sí", () => {
    expect(isForeignCurrency("USD")).toBe(true);
    expect(isForeignCurrency("DKK")).toBe(true);
  });
});
