import { describe, it, expect } from "vitest";
import { intracomVatIssue, isVatLinesIssue, mathIssues } from "@/lib/mathIssues";

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

  it("adquisición intracomunitaria: la cuota autorrepercutida no suma al total", () => {
    const compra = { ...base, lines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 19.84 }], operationType: "INTRACOM_SERVICIOS", direction: "PURCHASE" as const };
    expect(mathIssues({ ...compra, totalAmount: 94.46 })).toEqual([]);
    expect(mathIssues({ ...compra, totalAmount: 114.3 })).toEqual([{
      type: "MATH_MISMATCH",
      description: "El total (114,30 €) no coincide con Base (94,46 €). Diferencia: 19,84 €. En una adquisición intracomunitaria la cuota autorrepercutida no suma al total.",
    }]);
    // En una venta (entrega) el IVA sí suma.
    expect(mathIssues({ ...compra, operationType: "INTRACOM", direction: "SALE", totalAmount: 114.3 })).toEqual([]);
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

describe("intracomVatIssue", () => {
  const line = (vatRate: number, vatAmount: number) => ({ vatRate, vatAmount });

  it("intracomunitaria con IVA: aviso con el % de la línea", () => {
    expect(intracomVatIssue({ lines: [line(21, 21)], vatAmount: 21, vatRate: 21, operationType: "INTRACOM_SERVICIOS" })?.description)
      .toMatch(/^Operación intracomunitaria con IVA declarado \(21%\)/);
  });

  it("sin líneas: mira la cuota de la factura", () => {
    expect(intracomVatIssue({ lines: [], vatAmount: 21, vatRate: null, operationType: "INTRACOM" })?.description)
      .toMatch(/^Operación intracomunitaria con IVA declarado:/);
  });

  it("con IVA 0 o de otro tipo: nada", () => {
    expect(intracomVatIssue({ lines: [line(0, 0)], vatAmount: 0, vatRate: 0, operationType: "INTRACOM" })).toBeNull();
    expect(intracomVatIssue({ lines: [line(21, 21)], vatAmount: 21, vatRate: 21, operationType: "INTERIOR" })).toBeNull();
  });

  it("en una compra el IVA es el autorrepercutido: solo avisa en las ventas", () => {
    for (const operationType of ["INTRACOM", "INTRACOM_SERVICIOS"]) {
      expect(intracomVatIssue({ lines: [line(21, 21)], vatAmount: 21, vatRate: 21, operationType, direction: "PURCHASE" })).toBeNull();
    }
    expect(intracomVatIssue({ lines: [line(21, 21)], vatAmount: 21, vatRate: 21, operationType: "INTRACOM", direction: "SALE" }))
      .not.toBeNull();
  });
});
