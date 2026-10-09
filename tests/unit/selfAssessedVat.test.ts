import { describe, it, expect } from "vitest";
import {
  SELF_ASSESSED_VAT_RATE,
  applySelfAssessedRate,
  isSelfAssessedVat,
  isUntouchedSelfAssessedProposal,
  lacksSelfAssessedVat,
  removeSelfAssessedRate,
} from "@/lib/selfAssessedVat";

const line = (taxBase: string, vatRate: string, vatAmount: string) => ({ taxBase, vatRate, vatAmount });

describe("isSelfAssessedVat", () => {
  it("solo las compras con código 3 (bienes) u 8 (servicios)", () => {
    expect(SELF_ASSESSED_VAT_RATE).toBe(21);
    expect(isSelfAssessedVat("PURCHASE", "INTRACOM")).toBe(true);
    expect(isSelfAssessedVat("PURCHASE", "INTRACOM_SERVICIOS")).toBe(true);
    expect(isSelfAssessedVat("SALE", "INTRACOM")).toBe(false);
    for (const operationType of ["INTERIOR", "INVERSION_SP", "IMPORTACION", null, undefined]) {
      expect(isSelfAssessedVat("PURCHASE", operationType)).toBe(false);
    }
  });
});

describe("lacksSelfAssessedVat", () => {
  it("con base y sin cuota, tenga el % que tenga", () => {
    expect(lacksSelfAssessedVat({ taxBase: 94.46, vatAmount: 0 })).toBe(true);
    expect(lacksSelfAssessedVat({ taxBase: -94.46, vatAmount: 0.001 })).toBe(true);
    expect(lacksSelfAssessedVat({ taxBase: 94.46, vatAmount: 19.84 })).toBe(false);
    expect(lacksSelfAssessedVat({ taxBase: 0, vatAmount: 0 })).toBe(false);
  });
});

describe("applySelfAssessedRate", () => {
  it("la factura de Shopify: 94,46 € al 0 % pasa al 21 % con 19,84 € de cuota", () => {
    expect(applySelfAssessedRate([line("94.46", "0", "0")])).toEqual({
      lines: [line("94.46", "21", "19.84")],
      applied: true,
    });
  });

  it("también la que el OCR deja al 21 % con cuota 0 (la plantilla trae el 21)", () => {
    expect(applySelfAssessedRate([line("94.46", "21", "0")]).lines).toEqual([line("94.46", "21", "19.84")]);
  });

  it("el % y la cuota vacíos cuentan como 0; se conservan los demás campos", () => {
    const withSurcharge = { ...line("1950", "", ""), equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "" };
    expect(applySelfAssessedRate([withSurcharge]).lines).toEqual([
      { ...withSurcharge, vatRate: "21", vatAmount: "409.50" },
    ]);
  });

  it("rectificativa: la cuota sale con el signo de la base", () => {
    expect(applySelfAssessedRate([line("-94.46", "0", "0")]).lines).toEqual([line("-94.46", "21", "-19.84")]);
  });

  it("no toca lo que ya trae cuota, ni las líneas sin base o con base 0", () => {
    const lines = [line("100", "10", "10"), line("100", "0", "3"), line("", "0", "0"), line("0", "0", "0"), line("abc", "0", "0")];
    const result = applySelfAssessedRate(lines);
    expect(result.applied).toBe(false);
    expect(result.lines).toBe(lines);
  });

  it("con varias líneas solo cambia las que van sin cuota", () => {
    expect(applySelfAssessedRate([line("100", "10", "10"), line("50", "0", "0")]).lines)
      .toEqual([line("100", "10", "10"), line("50", "21", "10.50")]);
  });
});

describe("isUntouchedSelfAssessedProposal", () => {
  it("un borrador guardado con el 21 % propuesto sigue contando como propuesto", () => {
    expect(isUntouchedSelfAssessedProposal([line("94.46", "21", "19.84"), line("", "", "")])).toBe(true);
  });

  it("no si el gestor ha cambiado el tipo o la cuota, o no hay líneas con base", () => {
    expect(isUntouchedSelfAssessedProposal([line("94.46", "10", "9.45")])).toBe(false);
    expect(isUntouchedSelfAssessedProposal([line("94.46", "21", "20")])).toBe(false);
    expect(isUntouchedSelfAssessedProposal([line("94.46", "21", "19.84"), line("10", "10", "1")])).toBe(false);
    expect(isUntouchedSelfAssessedProposal([line("", "", "")])).toBe(false);
  });
});

describe("removeSelfAssessedRate", () => {
  it("vuelve al 0 % lo que sigue con el 21 % propuesto", () => {
    expect(removeSelfAssessedRate([line("94.46", "21", "19.84")])).toEqual([line("94.46", "0", "0")]);
    expect(removeSelfAssessedRate([line("-94.46", "21", "-19.84")])).toEqual([line("-94.46", "0", "0")]);
  });

  it("respeta otro tipo o una cuota tecleada a mano", () => {
    const lines = [line("100", "10", "10"), line("100", "21", "20"), line("", "", "")];
    expect(removeSelfAssessedRate(lines)).toEqual(lines);
  });

  it("aplicar y quitar deja las líneas como estaban", () => {
    const original = [line("94.46", "0", "0"), line("100", "10", "10")];
    expect(removeSelfAssessedRate(applySelfAssessedRate(original).lines)).toEqual(original);
  });
});
