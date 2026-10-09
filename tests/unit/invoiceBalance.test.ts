import { describe, it, expect } from "vitest";
import { BALANCE_TOLERANCE_CENTS, invoiceBalanceDiffCents, invoiceBalanceExpected, isInvoiceBalanced } from "@/lib/invoiceBalance";

describe("invoiceBalanceDiffCents", () => {
  it("Base + IVA + Recargo - IRPF frente al Total, en céntimos", () => {
    expect(invoiceBalanceDiffCents({ sumBase: 100, sumAmount: 21, total: 121 })).toBe(0);
    expect(invoiceBalanceDiffCents({ sumBase: 100, sumAmount: 21, sumSurcharge: 5.2, irpf: 15, total: 111.2 })).toBe(0);
    expect(invoiceBalanceDiffCents({ sumBase: 100, sumAmount: 21, total: 120.99 })).toBe(1);
    expect(invoiceBalanceDiffCents({ sumBase: 100, sumAmount: 21, total: 121.02 })).toBe(-2);
  });

  it("sin ruido de coma flotante", () => {
    expect(invoiceBalanceDiffCents({ sumBase: 0.1, sumAmount: 0.2, total: 0.3 })).toBe(0);
  });
});

describe("isInvoiceBalanced (F-058: una sola tolerancia)", () => {
  it("la tolerancia es 0 céntimos", () => {
    expect(BALANCE_TOLERANCE_CENTS).toBe(0);
  });

  it("cuadra exacto; 1 o 2 céntimos ya no cuadran, en los dos sentidos", () => {
    expect(isInvoiceBalanced({ sumBase: 100, sumAmount: 21, total: 121 })).toBe(true);
    expect(isInvoiceBalanced({ sumBase: 100, sumAmount: 21, total: 121.01 })).toBe(false);
    expect(isInvoiceBalanced({ sumBase: 100, sumAmount: 21, total: 120.98 })).toBe(false);
  });

  it("redondeo simétrico: una rectificativa no sale descuadrada con los dos importes iguales", () => {
    expect(invoiceBalanceDiffCents({ sumBase: -10.005, sumAmount: -2.1, total: -12.11 })).toBe(0);
    expect(invoiceBalanceDiffCents({ sumBase: 10.005, sumAmount: 2.1, total: 12.11 })).toBe(0);
  });

  it("abonos: el signo no cambia el resultado", () => {
    expect(isInvoiceBalanced({ sumBase: -100, sumAmount: -21, total: -121 })).toBe(true);
    expect(isInvoiceBalanced({ sumBase: -100, sumAmount: -21, total: -121.01 })).toBe(false);
  });
});

describe("IVA autorrepercutido (adquisición intracomunitaria)", () => {
  it("la cuota no suma: 94,46 € de base y 19,84 € de cuota dan 94,46 € de total", () => {
    const shopify = { sumBase: 94.46, sumAmount: 19.84, total: 94.46, selfAssessedVat: true };
    expect(isInvoiceBalanced(shopify)).toBe(true);
    expect(invoiceBalanceExpected(shopify)).toBe(94.46);
    expect(isInvoiceBalanced({ ...shopify, total: 114.3 })).toBe(false);
    expect(invoiceBalanceDiffCents({ ...shopify, total: 114.3 })).toBe(-1984);
  });

  it("el recargo y la retención siguen contando", () => {
    expect(invoiceBalanceExpected({ sumBase: 100, sumAmount: 21, sumSurcharge: 5.2, irpf: 15, total: 0, selfAssessedVat: true }))
      .toBeCloseTo(90.2, 10);
  });

  it("sin la marca, la cuota suma como siempre", () => {
    expect(invoiceBalanceExpected({ sumBase: 94.46, sumAmount: 19.84, total: 0 })).toBeCloseTo(114.3, 10);
  });
});
