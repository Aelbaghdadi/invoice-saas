import { describe, it, expect } from "vitest";
import { exportFingerprint } from "@/lib/exportFingerprint";

const base = {
  type: "PURCHASE",
  invoiceDate: new Date("2026-07-15"),
  invoiceNumber: "M-2604525",
  issuerName: "CARNICAS JOSELITO SL",
  issuerCif: "A87934337",
  issuerCountry: null,
  receiverName: "OTO MOYA SL",
  receiverCif: "B65638736",
  receiverCountry: null,
  operationType: "INTERIOR",
  supplierAccount: "40000022",
  expenseAccount: "60000001",
  irpfRate: 0,
  irpfAmount: 0,
  totalAmount: 1134.6,
  isRectificative: false,
  vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91 }],
};

describe("exportFingerprint — cambia cuando A3 va a ver algo distinto", () => {
  it("la misma factura da la misma huella", () => {
    expect(exportFingerprint(base)).toBe(exportFingerprint({ ...base }));
  });

  it("cambiar el nombre del emisor la cambia (caso Oto Moya / Joselito)", () => {
    expect(exportFingerprint({ ...base, issuerName: "OTO MOYA SL" })).not.toBe(exportFingerprint(base));
  });

  it("los ceros a la izquierda del numero cuentan: 23 no es 0023", () => {
    // A3 empareja por NIF + numero: si la huella los iguala, la correccion
    // del numero no vuelve a salir nunca en un Excel.
    expect(exportFingerprint({ ...base, invoiceNumber: "23" }))
      .not.toBe(exportFingerprint({ ...base, invoiceNumber: "0023" }));
  });

  it("un espacio de mas en el nombre tambien cuenta: va tal cual a la celda", () => {
    expect(exportFingerprint({ ...base, issuerName: "CARNICAS JOSELITO SL " })).not.toBe(exportFingerprint(base));
  });

  it("un NIF todo digitos con y sin cero inicial son distintos", () => {
    expect(exportFingerprint({ ...base, issuerCif: "01234567890", issuerCountry: "IT" }))
      .not.toBe(exportFingerprint({ ...base, issuerCif: "1234567890", issuerCountry: "IT" }));
  });

  it("pais ES y sin pais dan la misma huella: la columna E sale igual", () => {
    // El formulario hace ese vaiven en cada guardado (parseTaxId quita el
    // prefijo ES). Si contara, cualquier guardado sacaria la factura otra vez.
    expect(exportFingerprint({ ...base, issuerCountry: "ES" })).toBe(exportFingerprint({ ...base, issuerCountry: null }));
  });

  it("un prefijo extranjero si cuenta (columna E)", () => {
    expect(exportFingerprint({ ...base, issuerCountry: "PT" })).not.toBe(exportFingerprint(base));
  });

  it("en una emitida mira al receptor, no al emisor", () => {
    const venta = { ...base, type: "SALE" };
    expect(exportFingerprint({ ...venta, issuerName: "OTRO NOMBRE" })).toBe(exportFingerprint(venta));
    expect(exportFingerprint({ ...venta, receiverName: "OTRO CLIENTE" })).not.toBe(exportFingerprint(venta));
  });

  it("cambiar la cuenta contable la cambia", () => {
    expect(exportFingerprint({ ...base, expenseAccount: "62900000" })).not.toBe(exportFingerprint(base));
  });

  it("cambiar un importe de una linea la cambia", () => {
    expect(exportFingerprint({ ...base, vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.92 }] }))
      .not.toBe(exportFingerprint(base));
  });

  it("poner el recargo de una linea la cambia", () => {
    expect(exportFingerprint({
      ...base,
      vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 48.76 }],
    })).not.toBe(exportFingerprint(base));
  });

  it("recargo ausente y recargo a cero son lo mismo: el fichero emite 0 en los dos casos", () => {
    expect(exportFingerprint({
      ...base,
      vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null }],
    })).toBe(exportFingerprint({
      ...base,
      vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91, equivalenceSurchargeRate: 0, equivalenceSurchargeAmount: 0 }],
    }));
  });

  it("marcarla como rectificativa la cambia: el numero sale con _R", () => {
    expect(exportFingerprint({ ...base, isRectificative: true })).not.toBe(exportFingerprint(base));
  });

  it("los datos de control de la rectificativa no cuentan: no van al fichero", () => {
    const conControl = { ...base, isRectificative: true, rectifiedInvoiceNumber: "M-2604400", rectificativeType: "SUSTITUTIVA", art80Tres: true };
    expect(exportFingerprint(conControl)).toBe(exportFingerprint({ ...base, isRectificative: true }));
  });

  it("la moneda no cuenta: no hay columna de moneda en A3", () => {
    expect(exportFingerprint({ ...base, currency: "USD" })).toBe(exportFingerprint(base));
  });

  it("un Decimal de Prisma y un number del formulario dan la misma huella", () => {
    const comoBd = { ...base, totalAmount: "1134.60", vatLines: [{ taxBase: "937.69", vatRate: "21.00", vatAmount: "196.91" }] };
    expect(exportFingerprint(comoBd)).toBe(exportFingerprint(base));
  });

  it("una fecha Date y su cadena YYYY-MM-DD dan la misma huella", () => {
    expect(exportFingerprint({ ...base, invoiceDate: "2026-07-15" })).toBe(exportFingerprint(base));
  });

  it("reordenar las lineas de IVA no la cambia", () => {
    const dosLineas = [
      { taxBase: 100, vatRate: 21, vatAmount: 21 },
      { taxBase: 50, vatRate: 10, vatAmount: 5 },
    ];
    expect(exportFingerprint({ ...base, vatLines: dosLineas }))
      .toBe(exportFingerprint({ ...base, vatLines: [...dosLineas].reverse() }));
  });

  it("anadir una linea si la cambia", () => {
    expect(exportFingerprint({
      ...base,
      vatLines: [...base.vatLines, { taxBase: 50, vatRate: 10, vatAmount: 5 }],
    })).not.toBe(exportFingerprint(base));
  });

  it("sin desglose usa los campos planos, que es lo que exporta el fichero", () => {
    const plana = { ...base, vatLines: [], taxBase: 937.69, vatRate: 21, vatAmount: 196.91 };
    expect(exportFingerprint(plana)).toBe(exportFingerprint(base));
    expect(exportFingerprint({ ...plana, vatAmount: 196.92 })).not.toBe(exportFingerprint(plana));
  });

  it("cambiar el tipo de operacion la cambia (columna G)", () => {
    expect(exportFingerprint({ ...base, operationType: "INTRACOM" })).not.toBe(exportFingerprint(base));
  });
});
