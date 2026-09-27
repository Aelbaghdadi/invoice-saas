import { describe, it, expect } from "vitest";
import { parseTaxId } from "@/lib/validators";
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
  thirdPartyCountry: null,
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
    expect(validationProblems({ ...ok, isRectificative: true, lines: [], totalAmount: 0 })[0].message)
      .toBe("Falta al menos una línea de IVA (en una rectificativa puede ir a 0).");
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

  it("cuentas del sentido contrario (revisión 2 del PR #7)", () => {
    // Venta con las genéricas de proveedor (400/629).
    expect(validationProblems({ ...ok, type: "SALE", supplierAccount: "40099999", expenseAccount: "62900000" })[0]).toEqual({
      rule: "cuenta_sentido",
      message: "La cuenta 40099999 es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).",
    });
    expect(rules({ type: "SALE", supplierAccount: "43000001", expenseAccount: "62900000" })).toEqual(["cuenta_sentido"]);
    expect(rules({ type: "SALE", supplierAccount: "43000001", expenseAccount: "70000001" })).toEqual([]);
    expect(rules({ supplierAccount: "43000001" })).toEqual(["cuenta_sentido"]);
    expect(rules({ expenseAccount: "70000001" })).toEqual(["cuenta_sentido"]);
    // 44x o 2xx son contrapartidas legítimas.
    expect(rules({ type: "SALE", supplierAccount: "44000001", expenseAccount: "20000001" })).toEqual([]);
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
  it("con el NIF limpio que usa la pantalla, «-» es un NIF vacío", () => {
    // La pantalla pasa parseTaxId(...).clean, como guarda el servidor.
    expect(parseTaxId(" - ").clean).toBe("");
    expect(rules({ thirdPartyTaxId: parseTaxId("-").clean || null })).toEqual(["sin_nif"]);
  });

  it("hace falta en compras nacionales", () => {
    expect(rules({ thirdPartyTaxId: "" })).toEqual(["sin_nif"]);
    expect(validationProblems({ ...ok, thirdPartyTaxId: null })[0].message).toContain("Falta el NIF del proveedor");
    expect(rules({ thirdPartyTaxId: null, operationType: null })).toEqual(["sin_nif"]);
    expect(rules({ thirdPartyTaxId: null, operationType: "AGRARIA" })).toEqual(["sin_nif"]);
  });

  it("en ventas nacionales no: no hay genérica de clientes (revisión 1 del PR #7)", () => {
    const venta = { type: "SALE" as const, supplierAccount: "43000001", expenseAccount: "70000001" };
    expect(rules({ ...venta, thirdPartyTaxId: null })).toEqual([]);
    expect(rules({ ...venta, thirdPartyTaxId: null, operationType: "INTRACOM" })).toEqual(["sin_nif"]);
  });

  it("la genérica se compara completada: una antigua de 7 dígitos sigue valiendo", () => {
    expect(usesSimplifiedAccount({ supplierAccount: "40099990", simplifiedSupplierAccount: "4009999" })).toBe(true);
    expect(usesSimplifiedAccount({ supplierAccount: "400.9999", simplifiedSupplierAccount: "40009999" })).toBe(true);
    expect(usesSimplifiedAccount({ supplierAccount: "40000001", simplifiedSupplierAccount: "4009999" })).toBe(false);
  });

  it("sin genérica configurada, el mensaje manda a configurarla, no a usarla", () => {
    expect(validationProblems({ ...ok, thirdPartyTaxId: null, simplifiedSupplierAccount: null })[0].message).toBe(
      "Falta el NIF del proveedor. Si es un ticket o una factura simplificada, pide a un administrador que configure la cuenta genérica del cliente.",
    );
    expect(validationProblems({ ...ok, thirdPartyTaxId: null })[0].message).toContain("usa la cuenta genérica del cliente");
  });

  it("no con la cuenta genérica de simplificadas y tickets", () => {
    expect(rules({ thirdPartyTaxId: null, supplierAccount: "40099999" })).toEqual([]);
    expect(rules({ thirdPartyTaxId: null, supplierAccount: " 40099999 " })).toEqual([]);
    expect(usesSimplifiedAccount({ supplierAccount: "40099999", simplifiedSupplierAccount: null })).toBe(false);
    expect(usesSimplifiedAccount({ supplierAccount: "", simplifiedSupplierAccount: "" })).toBe(false);
  });

  it("no en importaciones ni (pendiente del asesor) en inversión del sujeto pasivo", () => {
    for (const operationType of ["IMPORTACION", "INVERSION_SP"]) {
      expect(thirdPartyTaxIdRequired({ ...ok, operationType })).toBe(false);
      expect(rules({ operationType, thirdPartyTaxId: null })).toEqual([]);
    }
  });

  it("en intracomunitarias, el NIF-IVA con el prefijo del país (decidido en el PR #7)", () => {
    for (const operationType of ["INTRACOM", "INTRACOM_SERVICIOS"]) {
      expect(thirdPartyTaxIdRequired({ ...ok, operationType })).toBe(true);
      expect(rules({ operationType, thirdPartyTaxId: "515160873", thirdPartyCountry: "PT" })).toEqual([]);
      expect(rules({ operationType, thirdPartyTaxId: null })).toEqual(["sin_nif"]);
      expect(rules({ operationType, thirdPartyTaxId: "515160873", thirdPartyCountry: null })).toEqual(["sin_nif_iva"]);
      expect(rules({ operationType, thirdPartyTaxId: "B12345674", thirdPartyCountry: "ES" })).toEqual(["sin_nif_iva"]);
    }
    expect(validationProblems({ ...ok, operationType: "INTRACOM", thirdPartyTaxId: null })[0].message)
      .toBe("Falta el NIF-IVA del proveedor: en una operación intracomunitaria hace falta para el modelo 349 y para A3.");
    expect(validationProblems({ ...ok, type: "SALE", operationType: "INTRACOM", thirdPartyTaxId: "515160873" })[0].message)
      .toBe("El NIF del destinatario no lleva el prefijo del país: en una operación intracomunitaria hace falta el NIF-IVA (p. ej. PT515160873).");
  });

  it("la cuenta genérica no exime a una intracomunitaria", () => {
    expect(rules({ operationType: "INTRACOM", thirdPartyTaxId: null, supplierAccount: "40099999" })).toEqual(["sin_nif"]);
  });
});

describe("missingDataProblems", () => {
  it("no mira el cuadre", () => {
    expect(missingDataProblems({ ...ok, totalAmount: 500 })).toEqual([]);
  });
});
