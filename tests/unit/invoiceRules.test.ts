import { describe, it, expect } from "vitest";
import {
  missingDataProblems, thirdPartyTaxIdRequired, usesSimplifiedAccount, validationProblems, type RuleInvoice,
} from "@/lib/invoiceRules";

const ok: RuleInvoice = {
  type: "PURCHASE",
  invoiceNumber: "F-1",
  invoiceDate: "2026-09-10",
  totalAmount: 121,
  irpfAmount: null,
  lines: [{ taxBase: 100, vatAmount: 21 }],
  isRectificative: false,
  thirdPartyTaxId: "B12345674",
  operationType: "INTERIOR",
  supplierAccount: "40000001",
  expenseAccount: "60000001",
  simplifiedSupplierAccount: "40099999",
  currency: null,
};
const rules = (over: Partial<RuleInvoice>) => validationProblems({ ...ok, ...over }).map((p) => p.rule);

describe("validationProblems (F-009, F-014)", () => {
  it("una factura completa y cuadrada se puede validar", () => {
    expect(validationProblems(ok)).toEqual([]);
    expect(validationProblems({ ...ok, invoiceDate: new Date("2026-09-10") })).toEqual([]);
  });

  it("sin total, fecha o número", () => {
    expect(rules({ totalAmount: null })).toEqual(["sin_total"]);
    expect(rules({ invoiceDate: null })).toEqual(["sin_fecha"]);
    expect(rules({ invoiceDate: "  " })).toEqual(["sin_fecha"]);
    expect(rules({ invoiceNumber: "" })).toEqual(["sin_numero"]);
    expect(rules({ invoiceNumber: " " })).toEqual(["sin_numero"]);
  });

  it("al menos una línea con base distinta de 0", () => {
    expect(rules({ lines: [], totalAmount: 0 })).toEqual(["sin_lineas"]);
    expect(rules({ lines: [{ taxBase: 0, vatAmount: 0 }], totalAmount: 0 })).toEqual(["sin_lineas"]);
    expect(rules({ lines: [{ taxBase: 0, vatAmount: 0 }, { taxBase: 100, vatAmount: 21 }] })).toEqual([]);
    // Abono: base negativa también vale.
    expect(rules({ lines: [{ taxBase: -100, vatAmount: -21 }], totalAmount: -121 })).toEqual([]);
  });

  it("una rectificativa a cero no se bloquea si tiene su línea", () => {
    expect(rules({ isRectificative: true, lines: [{ taxBase: 0, vatAmount: 0 }], totalAmount: 0 })).toEqual([]);
    expect(rules({ isRectificative: true, lines: [], totalAmount: 0 })).toEqual(["sin_lineas"]);
  });

  it("descuadre con la tolerancia común (0 céntimos), contando recargo e IRPF", () => {
    expect(rules({ totalAmount: 121.01 })).toEqual(["descuadre"]);
    expect(validationProblems({ ...ok, totalAmount: 120 })[0].message)
      .toBe("El importe no cuadra: las líneas suman 121,00 € y el total es 120,00 €.");
    expect(rules({ lines: [{ taxBase: 100, vatAmount: 21, equivalenceSurchargeAmount: 5.2 }], irpfAmount: 15, totalAmount: 111.2 }))
      .toEqual([]);
  });

  it("en otra moneda sin convertir (F-025)", () => {
    expect(rules({ currency: "USD" })).toEqual(["moneda"]);
    expect(validationProblems({ ...ok, currency: "USD" })[0].message).toBe(
      "Los importes están en USD: A3 solo admite euros. Conviértelos a euros y pulsa «Ya están en euros» antes de validar.",
    );
    expect(rules({ currency: "EUR" })).toEqual([]);
    expect(rules({ currency: "" })).toEqual([]);
  });

  it("sin cuentas", () => {
    expect(rules({ supplierAccount: "" })).toEqual(["sin_cuentas"]);
    expect(rules({ expenseAccount: null })).toEqual(["sin_cuentas"]);
  });

  it("varias a la vez, en orden de pantalla", () => {
    expect(rules({ thirdPartyTaxId: null, invoiceNumber: null, invoiceDate: null, totalAmount: null, lines: [] }))
      .toEqual(["sin_nif", "sin_numero", "sin_fecha", "sin_lineas", "sin_total"]);
  });
});

describe("NIF del tercero", () => {
  it("hace falta en operaciones nacionales, recibidas y emitidas", () => {
    expect(rules({ thirdPartyTaxId: "" })).toEqual(["sin_nif"]);
    expect(validationProblems({ ...ok, thirdPartyTaxId: null })[0].message).toContain("Falta el NIF del proveedor");
    expect(validationProblems({ ...ok, type: "SALE", thirdPartyTaxId: null })[0].message).toContain("Falta el NIF del destinatario");
    expect(rules({ thirdPartyTaxId: null, operationType: null })).toEqual(["sin_nif"]);
    expect(rules({ thirdPartyTaxId: null, operationType: "AGRARIA" })).toEqual(["sin_nif"]);
  });

  it("no con la cuenta genérica de simplificadas y tickets", () => {
    expect(rules({ thirdPartyTaxId: null, supplierAccount: "40099999" })).toEqual([]);
    expect(rules({ thirdPartyTaxId: null, supplierAccount: " 40099999 " })).toEqual([]);
    expect(usesSimplifiedAccount({ supplierAccount: "40099999", simplifiedSupplierAccount: null })).toBe(false);
    expect(usesSimplifiedAccount({ supplierAccount: "", simplifiedSupplierAccount: "" })).toBe(false);
  });

  it("no en operaciones que pueden ser con un extranjero sin NIF español", () => {
    for (const operationType of ["INTRACOM", "INTRACOM_SERVICIOS", "IMPORTACION", "INVERSION_SP"]) {
      expect(thirdPartyTaxIdRequired({ ...ok, operationType })).toBe(false);
    }
  });
});

describe("missingDataProblems", () => {
  it("no mira el cuadre", () => {
    expect(missingDataProblems({ ...ok, totalAmount: 500 })).toEqual([]);
  });
});
