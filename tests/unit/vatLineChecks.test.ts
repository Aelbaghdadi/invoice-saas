import { describe, it, expect } from "vitest";
import { describeVatLineMismatch, vatLineMismatches } from "@/lib/vatLineChecks";
import { validateForA3Export, type InvoiceWithClient } from "@/lib/exportFormats";

describe("vatLineMismatches (F-022)", () => {
  it("cuotas correctas, sin marcas", () => {
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21 },
      { taxBase: 200, vatRate: 10, vatAmount: 20 },
      { taxBase: 50, vatRate: 0, vatAmount: 0 },
    ])).toEqual([]);
  });

  it("el caso de la auditoría: cuotas cruzadas entre tipos con el total cuadrado", () => {
    // 100 al 21 % con cuota 20 y 200 al 10 % con cuota 21: suman 341 igual.
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 20 },
      { taxBase: 200, vatRate: 10, vatAmount: 21 },
    ])).toEqual([
      { index: 0, kind: "iva", rate: 21, expected: 21, actual: 20 },
      { index: 1, kind: "iva", rate: 10, expected: 20, actual: 21 },
    ]);
  });

  it("umbral max(0,02 €; 0,5 % de la cuota)", () => {
    // Cuota esperada 2,10: el 0,5 % es menos de 2 céntimos, así que tolera 2.
    expect(vatLineMismatches([{ taxBase: 10, vatRate: 21, vatAmount: 2.12 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 10, vatRate: 21, vatAmount: 2.13 }])).toHaveLength(1);
    // Cuota esperada 21,00: el 0,5 % son 10,5 céntimos.
    expect(vatLineMismatches([{ taxBase: 100, vatRate: 21, vatAmount: 21.1 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 100, vatRate: 21, vatAmount: 20.89 }])).toHaveLength(1);
    // Cuota esperada 2.100,00: el 0,5 % son 10,50 €.
    expect(vatLineMismatches([{ taxBase: 10000, vatRate: 21, vatAmount: 2110.5 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: 10000, vatRate: 21, vatAmount: 2110.51 }])).toHaveLength(1);
    // Redondeo a céntimos de la cuota esperada: 33,33 × 21 % = 6,9993 → 7,00.
    expect(vatLineMismatches([{ taxBase: 33.33, vatRate: 21, vatAmount: 7 }])).toEqual([]);
  });

  it("abonos en negativo", () => {
    expect(vatLineMismatches([{ taxBase: -100, vatRate: 21, vatAmount: -21 }])).toEqual([]);
    expect(vatLineMismatches([{ taxBase: -100, vatRate: 21, vatAmount: 21 }])).toHaveLength(1);
  });

  it("también el recargo de equivalencia, cuando la línea lo lleva", () => {
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2 },
    ])).toEqual([]);
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 1.4 },
    ])).toEqual([{ index: 0, kind: "recargo", rate: 5.2, expected: 5.2, actual: 1.4 }]);
    // Sin recargo (null) no se mira.
    expect(vatLineMismatches([
      { taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
    ])).toEqual([]);
  });

  it("ni en inversión del sujeto pasivo ni en intracomunitarias", () => {
    const line = [{ taxBase: 100, vatRate: 21, vatAmount: 0 }];
    for (const op of ["INVERSION_SP", "INTRACOM", "INTRACOM_SERVICIOS"]) expect(vatLineMismatches(line, op)).toEqual([]);
    expect(vatLineMismatches(line, "INTERIOR")).toHaveLength(1);
    expect(vatLineMismatches(line, "IMPORTACION")).toHaveLength(1);
  });

  it("el texto dice línea, qué cuota y cuánto daría", () => {
    expect(describeVatLineMismatch({ index: 1, kind: "iva", rate: 10, expected: 20, actual: 21 }))
      .toBe("Línea 2: la cuota de IVA es 21,00 € y la base × 10 % da 20,00 €");
    expect(describeVatLineMismatch({ index: 0, kind: "recargo", rate: 5.2, expected: 5.2, actual: 1.4 }))
      .toBe("Línea 1: el recargo de equivalencia es 1,40 € y la base × 5,2 % da 5,20 €");
  });
});

describe("validateForA3Export avisa de las cuotas cruzadas", () => {
  const inv = {
    id: "inv-1", type: "PURCHASE", invoiceDate: new Date("2026-04-15"), invoiceNumber: "F-001",
    issuerName: "Suministros S.L.", issuerCif: "B12345674", totalAmount: 341,
    supplierAccount: "4000001", expenseAccount: "6000001", client: { id: "c1", name: "ACME SL" },
    vatLines: [
      { taxBase: 100, vatRate: 21, vatAmount: 20, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
      { taxBase: 200, vatRate: 10, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
    ],
  } as unknown as InvoiceWithClient;

  it("antes devolvía []; ahora un aviso por línea", () => {
    expect(validateForA3Export([inv])).toEqual([{
      invoiceId: "inv-1", invoiceNumber: "F-001",
      warnings: [
        "Línea 1: la cuota de IVA es 20,00 € y la base × 21 % da 21,00 €",
        "Línea 2: la cuota de IVA es 21,00 € y la base × 10 % da 20,00 €",
      ],
    }]);
  });
});
