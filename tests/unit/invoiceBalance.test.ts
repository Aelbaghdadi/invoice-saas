import { describe, it, expect } from "vitest";
import { BALANCE_TOLERANCE_CENTS, invoiceBalanceDiffCents, isInvoiceBalanced } from "@/lib/invoiceBalance";

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
