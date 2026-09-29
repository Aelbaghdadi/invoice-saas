import { describe, it, expect } from "vitest";
import {
  textMentionsRectificative,
  applyRectificativeSign,
  rectificativeSignHint,
  withRectificativeMention,
  hasRectificativeMention,
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

  it("pasa a negativo la cuota de recargo, pero no su %", () => {
    const out = applyRectificativeSign({
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2 }],
      taxBase: 100, vatAmount: 21, totalAmount: 126.2, irpfAmount: null, retentionBase: null,
    });
    expect(out.lines[0].equivalenceSurchargeRate).toBe(5.2);
    expect(out.lines[0].equivalenceSurchargeAmount).toBe(-5.2);
  });

  it("un abono que ya trae el recargo en negativo no se vuelve a tocar", () => {
    const input = {
      lines: [{ taxBase: -100, vatRate: 21, vatAmount: -21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: -5.2 }],
      taxBase: -100, vatAmount: -21, totalAmount: -126.2, irpfAmount: null, retentionBase: null,
    };
    expect(applyRectificativeSign(input)).toEqual(input);
  });
});

describe("rectificativeSignHint (F-012: el OCR no cambia signos)", () => {
  const amounts = (base: number, vat: number, total: number) => ({
    lines: [{ taxBase: base, vatRate: 21, vatAmount: vat }], taxBase: base, vatAmount: vat, totalAmount: total, irpfAmount: null, retentionBase: null,
  });

  it("con la mención en el texto y todo en positivo: «Parece rectificativa: revisa el signo»", () => {
    expect(rectificativeSignHint(amounts(100, 21, 121), "FACTURA RECTIFICATIVA Nº R-1")).toMatch(/^Parece rectificativa: revisa el signo\./);
    expect(rectificativeSignHint(amounts(100, 21, 121), "Esta factura no es rectificativa")).toBeNull();
  });

  it("con importes negativos: marcar la casilla o corregir el signo", () => {
    expect(rectificativeSignHint(amounts(-100, -21, -121), null)).toMatch(/^La factura trae importes negativos/);
  });

  it("una factura normal: nada", () => {
    expect(rectificativeSignHint(amounts(100, 21, 121), "Forma de pago: abono en cuenta")).toBeNull();
  });
});

describe("textMentionsRectificative: negaciones y espacios (revisión 1 del PR #9)", () => {
  it("las negaciones no cuentan", () => {
    for (const text of [
      "Esta factura no es rectificativa",
      "Rectificativa: No",
      "Tipo de factura: Ordinaria · Rectificativa: No",
      "No es una factura rectificativa",
      "RECTIFICATIVA = NO",
    ]) {
      expect(textMentionsRectificative(text), text).toBe(false);
    }
  });

  it("los dobles espacios de pdfjs, sí", () => {
    expect(textMentionsRectificative("Factura  de  abono Nº 12")).toBe(true);
    expect(textMentionsRectificative("NOTA   DE CRÉDITO")).toBe(true);
  });

  it("«No» o «Nº» seguido del número de la factura no es una negación", () => {
    for (const text of [
      "FACTURA RECTIFICATIVA: No. R-2026-01",
      "Factura de abono: No. 12",
      "No Factura Rectificativa: R-2026-001",
      "RECTIFICATIVA: No 2026/15",
    ]) {
      expect(textMentionsRectificative(text), text).toBe(true);
    }
  });

  it("una rectificativa de verdad sigue contando, aunque el texto diga «no» en otra parte", () => {
    expect(textMentionsRectificative("FACTURA RECTIFICATIVA R-1 · No incluye portes")).toBe(true);
    expect(textMentionsRectificative("Rectificativa: Sí")).toBe(true);
  });
});

describe("la mención guardada en el buzón (revisión 1 del PR #9, punto 8)", () => {
  it("se añade al JSON crudo y se lee", () => {
    const raw = withRectificativeMention(JSON.stringify({ source: "gemini_text", textLength: 900 }));
    expect(JSON.parse(raw)).toEqual({ source: "gemini_text", textLength: 900, rectificativeMention: true });
    expect(hasRectificativeMention(raw)).toBe(true);
  });

  it("un XML se deja igual; sin marca, no hay mención", () => {
    expect(withRectificativeMention("<Facturae/>")).toBe("<Facturae/>");
    expect(hasRectificativeMention("<Facturae/>")).toBe(false);
    expect(hasRectificativeMention(JSON.stringify({ source: "gemini_text" }))).toBe(false);
  });
});
