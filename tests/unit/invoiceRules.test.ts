import { describe, it, expect } from "vitest";
import { parseTaxId } from "@/lib/validators";
import {
  accountsAgainstDirection, missingDataProblems, thirdPartyTaxIdRequired, usesSimplifiedAccount, validationProblems, vatBreakdownMismatches,
  type RuleInvoice,
} from "@/lib/invoiceRules";
import { vatLineFix, vatLineMismatches } from "@/lib/vatLineChecks";

const ok: RuleInvoice = {
  type: "PURCHASE",
  invoiceNumber: "F-1",
  invoiceDate: "2026-09-10",
  totalAmount: 121,
  irpfAmount: null,
  lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
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
    expect(rules({ lines: [{ taxBase: 0, vatRate: 21, vatAmount: 0 }], totalAmount: 0 })).toEqual(["sin_lineas"]);
    expect(rules({ lines: [{ taxBase: 0, vatRate: 21, vatAmount: 0 }, { taxBase: 100, vatRate: 21, vatAmount: 21 }] })).toEqual([]);
    // Abono: base negativa también vale.
    expect(rules({ lines: [{ taxBase: -100, vatRate: 21, vatAmount: -21 }], totalAmount: -121 })).toEqual([]);
  });

  it("una rectificativa a cero no se bloquea si tiene su línea", () => {
    expect(rules({ isRectificative: true, lines: [{ taxBase: 0, vatRate: 21, vatAmount: 0 }], totalAmount: 0 })).toEqual([]);
    expect(rules({ isRectificative: true, lines: [], totalAmount: 0 })).toEqual(["sin_lineas"]);
    expect(validationProblems({ ...ok, isRectificative: true, lines: [], totalAmount: 0 })[0].message)
      .toBe("Falta al menos una línea de IVA (en una rectificativa puede ir a 0).");
  });

  it("descuadre con la tolerancia común (0 céntimos), contando recargo e IRPF", () => {
    expect(rules({ totalAmount: 121.01 })).toEqual(["descuadre"]);
    expect(validationProblems({ ...ok, totalAmount: 120 })[0].message)
      .toBe("El importe no cuadra: las líneas suman 121,00 € y el total es 120,00 €.");
    expect(rules({
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 5.2 }],
      irpfAmount: 15, totalAmount: 111.2,
    })).toEqual([]);
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

  it("compara las cuentas completadas: «4.1» es la 40000001", () => {
    expect(validationProblems({ ...ok, type: "SALE", supplierAccount: "4.1", expenseAccount: "70000001" })[0]?.message).toBe(
      "La cuenta 40000001 es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).",
    );
    expect(rules({ supplierAccount: "4.1", expenseAccount: "6.1" })).toEqual([]);
    // Sin punto se enseña tal cual, como va a la columna H (no 40000010).
    expect(validationProblems({ ...ok, type: "SALE", supplierAccount: "4000001", expenseAccount: "70000001" })[0]?.message).toBe(
      "La cuenta 4000001 es de proveedor y esta factura es emitida: usa una cuenta de cliente (43x).",
    );
  });

  it("las cuentas que minoran no son del sentido contrario (rappels, devoluciones, descuentos)", () => {
    for (const account of ["60600000", "60800000", "60900001"]) {
      expect(rules({ type: "SALE", supplierAccount: "43000001", expenseAccount: account })).toEqual([]);
    }
    for (const account of ["70600000", "70800000", "70900001"]) {
      expect(rules({ expenseAccount: account })).toEqual([]);
    }
    // El resto del 60x/70x sigue siendo del sentido contrario.
    expect(rules({ type: "SALE", supplierAccount: "43000001", expenseAccount: "60000001" })).toEqual(["cuenta_sentido"]);
    expect(rules({ expenseAccount: "70500000" })).toEqual(["cuenta_sentido"]);
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
      // Compra intracomunitaria: la cuota es autorrepercutida y el total es la base.
      const intracom = { operationType, totalAmount: 100 };
      expect(thirdPartyTaxIdRequired({ ...ok, operationType })).toBe(true);
      expect(rules({ ...intracom, thirdPartyTaxId: "515160873", thirdPartyCountry: "PT" })).toEqual([]);
      expect(rules({ ...intracom, thirdPartyTaxId: null })).toEqual(["sin_nif"]);
      expect(rules({ ...intracom, thirdPartyTaxId: "515160873", thirdPartyCountry: null })).toEqual(["sin_nif_iva"]);
      expect(rules({ ...intracom, thirdPartyTaxId: "B12345674", thirdPartyCountry: "ES" })).toEqual(["sin_nif_iva"]);
    }
    expect(validationProblems({ ...ok, operationType: "INTRACOM", thirdPartyTaxId: null })[0].message)
      .toBe("Falta el NIF-IVA del proveedor: en una operación intracomunitaria hace falta para el modelo 349 y para A3.");
    expect(validationProblems({ ...ok, type: "SALE", operationType: "INTRACOM", thirdPartyTaxId: "515160873" })[0].message)
      .toBe("El NIF del destinatario no lleva el prefijo del país: en una operación intracomunitaria hace falta el NIF-IVA (p. ej. PT515160873).");
  });

  it("la cuenta genérica no exime a una intracomunitaria", () => {
    expect(rules({ operationType: "INTRACOM", totalAmount: 100, thirdPartyTaxId: null, supplierAccount: "40099999" })).toEqual(["sin_nif"]);
  });
});

describe("cuadre de las adquisiciones intracomunitarias (IVA autorrepercutido)", () => {
  // La factura de Shopify que mandó el asesor: base 94,46 € al 0 %.
  const compra: Partial<RuleInvoice> = {
    operationType: "INTRACOM_SERVICIOS",
    thirdPartyTaxId: "515160873",
    thirdPartyCountry: "PT",
    lines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 19.84 }],
  };

  it("la cuota no suma al total, en bienes (3) y en servicios (8)", () => {
    expect(rules({ ...compra, totalAmount: 94.46 })).toEqual([]);
    expect(rules({ ...compra, operationType: "INTRACOM", totalAmount: 94.46 })).toEqual([]);
  });

  it("si el total lleva la cuota no cuadra, y el mensaje dice por qué", () => {
    expect(validationProblems({ ...ok, ...compra, totalAmount: 114.3 })[0].message)
      .toBe("El importe no cuadra: sin la cuota autorrepercutida, las líneas suman 94,46 € y el total es 114,30 €.");
  });

  it("en una venta intracomunitaria la cuota sí suma", () => {
    const venta = { type: "SALE" as const, supplierAccount: "43000001", expenseAccount: "70000001" };
    expect(rules({ ...compra, ...venta, operationType: "INTRACOM", totalAmount: 94.46 })).toEqual(["descuadre"]);
    expect(rules({ ...compra, ...venta, operationType: "INTRACOM", totalAmount: 114.3 })).toEqual([]);
  });
});

describe("desglose por tipo (F-022): no deja validar aunque el total cuadre", () => {
  // El caso real que mandó el asesor, como lo guardó el OCR: los tipos de las
  // líneas 2 y 3 cruzados. En el documento, 1.312,18 va al 21 % y 2.538,10 al
  // 10 %. El total (5.721,14) cuadra igual.
  const casoReal: Partial<RuleInvoice> = {
    totalAmount: 5721.14,
    lines: [
      { taxBase: 1289.89, vatRate: 4, vatAmount: 51.6 },
      { taxBase: 1312.18, vatRate: 10, vatAmount: 275.56 },
      { taxBase: 2538.1, vatRate: 21, vatAmount: 253.81 },
    ],
  };

  it("el caso real: no se valida, y el mensaje dice qué líneas", () => {
    expect(validationProblems({ ...ok, ...casoReal })).toEqual([{
      rule: "desglose",
      message: "El desglose por tipo no cuadra (Línea 2: la cuota de IVA es 275,56 € y la base × 10 % da 131,22 €; "
        + "Línea 3: la cuota de IVA es 253,81 € y la base × 21 % da 533,00 €). Corrige el tipo, la base o la cuota antes de validar.",
    }]);
  });

  it("con los dos arreglos en un clic (vatLineFix) sí se valida", () => {
    const lines = casoReal.lines!.map((line) => ({ ...line }));
    for (const m of vatLineMismatches(lines)) {
      const fix = vatLineFix(lines[m.index].taxBase, m);
      Object.assign(lines[m.index], { [fix.field]: Number(fix.value) });
    }
    expect(lines.map((l) => l.vatRate)).toEqual([4, 21, 10]);
    expect(lines.map((l) => l.vatAmount)).toEqual([51.6, 275.56, 253.81]);
    expect(validationProblems({ ...ok, ...casoReal, lines })).toEqual([]);
  });

  it("los redondeos dentro de la tolerancia siguen dejando validar", () => {
    // 7 artículos de 1,15 € al 21 %: 0,24 de cuota cada uno (1,68), y la base
    // entera da 1,69.
    expect(rules({ lines: [{ taxBase: 8.05, vatRate: 21, vatAmount: 1.68 }], totalAmount: 9.73 })).toEqual([]);
    // El 0,5 % de 210 € son 1,05 €.
    expect(rules({ lines: [{ taxBase: 1000, vatRate: 21, vatAmount: 211.05 }], totalAmount: 1211.05 })).toEqual([]);
    expect(rules({ lines: [{ taxBase: 1000, vatRate: 21, vatAmount: 211.06 }], totalAmount: 1211.06 })).toEqual(["desglose"]);
    // Por debajo, 2 céntimos.
    expect(rules({ lines: [{ taxBase: 10, vatRate: 21, vatAmount: 2.12 }], totalAmount: 12.12 })).toEqual([]);
    expect(rules({ lines: [{ taxBase: 10, vatRate: 21, vatAmount: 2.13 }], totalAmount: 12.13 })).toEqual(["desglose"]);
  });

  it("en inversión del sujeto pasivo y en las ventas intracomunitarias no hay cuota que mirar", () => {
    const sinCuota = { lines: [{ taxBase: 100, vatRate: 21, vatAmount: 0 }], totalAmount: 100 };
    expect(rules({ ...sinCuota, operationType: "INVERSION_SP" })).toEqual([]);
    const venta = { type: "SALE" as const, supplierAccount: "43000001", expenseAccount: "70000001", thirdPartyTaxId: "515160873", thirdPartyCountry: "PT" };
    expect(rules({ ...sinCuota, ...venta, operationType: "INTRACOM" })).toEqual([]);
    // En una operación interior sí.
    expect(rules(sinCuota)).toEqual(["desglose"]);
  });

  it("la cuota autorrepercutida de una adquisición intracomunitaria sí se mira", () => {
    const compra = { operationType: "INTRACOM_SERVICIOS", thirdPartyTaxId: "515160873", thirdPartyCountry: "PT", totalAmount: 94.46 };
    expect(rules({ ...compra, lines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 19.84 }] })).toEqual([]);
    expect(validationProblems({ ...ok, ...compra, lines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 1.98 }] })).toEqual([{
      rule: "desglose",
      message: "El desglose por tipo no cuadra (Línea 1: la cuota de IVA es 1,98 € y la base × 21 % da 19,84 €). "
        + "Corrige el tipo, la base o la cuota antes de validar.",
    }]);
  });

  it("una adquisición intracomunitaria con el 21 % y cuota 0 se valida, como con el 0 %: a A3 le llega la autorrepercutida", () => {
    // Las validadas antes del 2026-10-09 están así; el export les pone el 21 %
    // y su cuota (a3Vat) y no avisa de nada. Corregirlas no puede quedarse
    // bloqueado por eso.
    const compra = { operationType: "INTRACOM_SERVICIOS", thirdPartyTaxId: "515160873", thirdPartyCountry: "PT", totalAmount: 94.46 };
    expect(rules({ ...compra, lines: [{ taxBase: 94.46, vatRate: 21, vatAmount: 0 }] })).toEqual([]);
    expect(rules({ ...compra, lines: [{ taxBase: 94.46, vatRate: 0, vatAmount: 0 }] })).toEqual([]);
  });

  it("una rectificativa que solo corrige la cuota (base 0) se valida", () => {
    // Se facturó al 10 % y era el 21 %: la base no cambia y la cuota sube 110 €.
    // La base × % siempre daría 0.
    const soloCuota = { lines: [{ taxBase: 0, vatRate: 21, vatAmount: 110 }], totalAmount: 110 };
    expect(rules({ ...soloCuota, isRectificative: true })).toEqual([]);
    // Sin la casilla no es una rectificativa, y la línea no tiene base.
    expect(rules(soloCuota)).toEqual(["sin_lineas", "desglose"]);
    // Una línea con base sí se mira, también en una rectificativa.
    expect(rules({ isRectificative: true, lines: [{ taxBase: -100, vatRate: 21, vatAmount: -10 }], totalAmount: -110 }))
      .toEqual(["desglose"]);
    // Las que marca la pantalla, con su posición.
    expect(vatBreakdownMismatches({
      ...ok, isRectificative: true,
      lines: [{ taxBase: 0, vatRate: 21, vatAmount: 110 }, { taxBase: -100, vatRate: 21, vatAmount: -10 }],
    })).toEqual([{ index: 1, kind: "iva", rate: 21, expected: -21, actual: -10 }]);
  });

  it("también el recargo de equivalencia", () => {
    const recargo = (amount: number) => ({
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: amount }],
      totalAmount: 121 + amount,
    });
    expect(rules(recargo(5.2))).toEqual([]);
    expect(validationProblems({ ...ok, ...recargo(1.4) })[0].message).toBe(
      "El desglose por tipo no cuadra (Línea 1: el recargo de equivalencia es 1,40 € y la base × 5,2 % da 5,20 €). "
        + "Corrige el tipo, la base o la cuota antes de validar.",
    );
  });

  it("con el total descuadrado también, primero el descuadre", () => {
    expect(rules({ ...casoReal, totalAmount: 5721.15 })).toEqual(["descuadre", "desglose"]);
  });
});

describe("missingDataProblems", () => {
  it("no mira el cuadre", () => {
    expect(missingDataProblems({ ...ok, totalAmount: 500 })).toEqual([]);
  });
});

describe("accountsAgainstDirection (al cambiar de sentido se vacían)", () => {
  it("a emitida: las genéricas de proveedor y gasto, y cualquier 40x/6xx", () => {
    expect(accountsAgainstDirection({ type: "SALE", supplierAccount: "40099999", expenseAccount: "62900000" }))
      .toEqual({ party: "40099999", result: "62900000" });
    expect(accountsAgainstDirection({ type: "SALE", supplierAccount: "4.1", expenseAccount: "6.1" }))
      .toEqual({ party: "40000001", result: "60000001" });
  });

  it("a recibida: una 43x y una 7xx", () => {
    expect(accountsAgainstDirection({ type: "PURCHASE", supplierAccount: "43000001", expenseAccount: "70000001" }))
      .toEqual({ party: "43000001", result: "70000001" });
  });

  it("las que encajan, las que minoran y las vacías se quedan", () => {
    expect(accountsAgainstDirection({ type: "SALE", supplierAccount: "43000001", expenseAccount: "60900000" }))
      .toEqual({ party: null, result: null });
    expect(accountsAgainstDirection({ type: "PURCHASE", supplierAccount: "", expenseAccount: null }))
      .toEqual({ party: null, result: null });
  });
});
