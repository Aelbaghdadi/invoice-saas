import { describe, it, expect } from "vitest";
import {
  textMentionsRectificative,
  applyRectificativeSign,
  type RectificativeAmounts,
} from "@/lib/rectificative";

describe("textMentionsRectificative", () => {
  it("detecta 'rectificativa' en cualquier caja y con tildes", () => {
    expect(textMentionsRectificative("FACTURA RECTIFICATIVA Nº R-001")).toBe(true);
    expect(textMentionsRectificative("factura rectificativa")).toBe(true);
    expect(textMentionsRectificative("Rectificación / Rectificativa")).toBe(true);
  });

  it("detecta 'nota de crédito' (con y sin tilde)", () => {
    expect(textMentionsRectificative("Nota de crédito")).toBe(true);
    expect(textMentionsRectificative("NOTA DE CREDITO")).toBe(true);
  });

  it("detecta 'factura de abono' pero no 'abono' suelto (forma de pago)", () => {
    expect(textMentionsRectificative("Factura de abono")).toBe(true);
    expect(textMentionsRectificative("Forma de pago: abono en cuenta")).toBe(false);
  });

  it("no detecta una factura normal", () => {
    expect(textMentionsRectificative("Factura simplificada nº 42")).toBe(false);
    expect(textMentionsRectificative("")).toBe(false);
    expect(textMentionsRectificative(null)).toBe(false);
    expect(textMentionsRectificative(undefined)).toBe(false);
  });
});

describe("applyRectificativeSign", () => {
  it("pasa a negativo cuando viene TODO en positivo", () => {
    const input: RectificativeAmounts = {
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
      taxBase: 100,
      vatAmount: 21,
      totalAmount: 121,
      irpfAmount: 15,
      retentionBase: 100,
    };
    const out = applyRectificativeSign(input);
    expect(out.lines[0]).toEqual({ taxBase: -100, vatRate: 21, vatAmount: -21 });
    expect(out.taxBase).toBe(-100);
    expect(out.vatAmount).toBe(-21);
    expect(out.totalAmount).toBe(-121);
    expect(out.irpfAmount).toBe(-15);
    expect(out.retentionBase).toBe(-100);
  });

  it("no cambia el % de IVA de signo", () => {
    const out = applyRectificativeSign({
      lines: [{ taxBase: 50, vatRate: 10, vatAmount: 5 }],
      taxBase: 50, vatAmount: 5, totalAmount: 55, irpfAmount: null, retentionBase: null,
    });
    expect(out.lines[0].vatRate).toBe(10);
  });

  it("respeta los signos si ya viene con líneas mixtas (+/-)", () => {
    const input: RectificativeAmounts = {
      lines: [
        { taxBase: 100, vatRate: 21, vatAmount: 21 },
        { taxBase: -125, vatRate: 10, vatAmount: -12.5 },
      ],
      taxBase: -25,
      vatAmount: 8.5,
      totalAmount: -16.5,
      irpfAmount: null,
      retentionBase: null,
    };
    const out = applyRectificativeSign(input);
    expect(out).toEqual(input); // intacto
  });

  it("respeta los importes si ya vienen todos en negativo", () => {
    const input: RectificativeAmounts = {
      lines: [{ taxBase: -100, vatRate: 21, vatAmount: -21 }],
      taxBase: -100, vatAmount: -21, totalAmount: -121, irpfAmount: null, retentionBase: null,
    };
    expect(applyRectificativeSign(input)).toEqual(input);
  });

  it("maneja nulls sin romper", () => {
    const out = applyRectificativeSign({
      lines: [], taxBase: null, vatAmount: null, totalAmount: 121, irpfAmount: null, retentionBase: null,
    });
    expect(out.totalAmount).toBe(-121);
    expect(out.taxBase).toBeNull();
  });
});
