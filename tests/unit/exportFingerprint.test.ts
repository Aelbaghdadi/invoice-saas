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
  operationType: "INTERIOR",
  supplierAccount: "40000022",
  expenseAccount: "60000001",
  irpfRate: 0,
  irpfAmount: 0,
  totalAmount: 1134.6,
  currency: "EUR",
  isRectificative: false,
  vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91 }],
};

describe("exportFingerprint", () => {
  it("la misma factura da la misma huella", () => {
    expect(exportFingerprint(base)).toBe(exportFingerprint({ ...base }));
  });

  it("cambiar el nombre del emisor cambia la huella (caso Oto Moya / Joselito)", () => {
    expect(exportFingerprint({ ...base, issuerName: "OTO MOYA SL" })).not.toBe(exportFingerprint(base));
  });

  it("cambiar la cuenta contable cambia la huella", () => {
    expect(exportFingerprint({ ...base, expenseAccount: "62900000" })).not.toBe(exportFingerprint(base));
  });

  it("cambiar un importe de una linea cambia la huella", () => {
    expect(exportFingerprint({ ...base, vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.92 }] }))
      .not.toBe(exportFingerprint(base));
  });

  it("poner o quitar el recargo de una linea cambia la huella", () => {
    expect(exportFingerprint({
      ...base,
      vatLines: [{ taxBase: 937.69, vatRate: 21, vatAmount: 196.91, equivalenceSurchargeRate: 5.2, equivalenceSurchargeAmount: 48.76 }],
    })).not.toBe(exportFingerprint(base));
  });

  it("cambiar el pais del NIF cambia la huella (columna E)", () => {
    expect(exportFingerprint({ ...base, issuerCountry: "PT" })).not.toBe(exportFingerprint(base));
  });

  it("un Decimal de Prisma y un number del formulario dan la misma huella", () => {
    const comoBd = { ...base, totalAmount: "1134.60", vatLines: [{ taxBase: "937.69", vatRate: "21.00", vatAmount: "196.91" }] };
    expect(exportFingerprint(comoBd)).toBe(exportFingerprint(base));
  });

  it("una fecha Date y su cadena YYYY-MM-DD dan la misma huella", () => {
    expect(exportFingerprint({ ...base, invoiceDate: "2026-07-15" })).toBe(exportFingerprint(base));
  });

  it("null y cadena vacia son lo mismo", () => {
    expect(exportFingerprint({ ...base, issuerCountry: "" })).toBe(exportFingerprint(base));
  });

  it("reordenar las lineas de IVA no cambia la huella", () => {
    const dosLineas = [
      { taxBase: 100, vatRate: 21, vatAmount: 21 },
      { taxBase: 50, vatRate: 10, vatAmount: 5 },
    ];
    expect(exportFingerprint({ ...base, vatLines: dosLineas }))
      .toBe(exportFingerprint({ ...base, vatLines: [...dosLineas].reverse() }));
  });

  it("anadir una linea si cambia la huella", () => {
    expect(exportFingerprint({
      ...base,
      vatLines: [...base.vatLines, { taxBase: 50, vatRate: 10, vatAmount: 5 }],
    })).not.toBe(exportFingerprint(base));
  });
});
