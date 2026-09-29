import { describe, it, expect } from "vitest";
import { isVatLinesIssue, mathIssues } from "@/lib/mathIssues";

const base = { taxBase: null, vatAmount: null, irpfAmount: null };

describe("mathIssues", () => {
  it("cuadrada y con el desglose bien: nada", () => {
    expect(mathIssues({ ...base, lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], totalAmount: 121 })).toEqual([]);
  });

  it("descuadre del total con la tolerancia común (1 céntimo ya cuenta)", () => {
    expect(mathIssues({ ...base, lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], totalAmount: 121.01 })).toEqual([{
      type: "MATH_MISMATCH",
      description: "El total (121,01 €) no coincide con Base + IVA (121,00 €). Diferencia: 0,01 €.",
    }]);
  });

  it("sin líneas usa la base y la cuota de la factura; sin total no mira el cuadre", () => {
    expect(mathIssues({ lines: [], taxBase: 100, vatAmount: 21, irpfAmount: 15, totalAmount: 106 })).toEqual([]);
    expect(mathIssues({ ...base, lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], totalAmount: null })).toEqual([]);
  });

  it("cuotas cruzadas: aviso de desglose, aunque el total cuadre", () => {
    const issues = mathIssues({
      ...base, totalAmount: 341,
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 20 }, { taxBase: 200, vatRate: 10, vatAmount: 21 }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toMatch(/^El desglose por tipo no cuadra\. Línea 1/);
    // Se distingue del descuadre del total por el field (sin migración).
    expect(issues[0].field).toBe("vatLines");
    expect(isVatLinesIssue(issues[0])).toBe(true);
    expect(isVatLinesIssue({ type: "MATH_MISMATCH", field: null })).toBe(false);
  });
});
