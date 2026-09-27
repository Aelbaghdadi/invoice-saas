import { describe, it, expect } from "vitest";
import { amountFieldsProblem, parseVatLineInputs, vatLineProblem, vatLinesProblem } from "@/lib/vatLineInput";

const line = (taxBase: string, vatRate: string, vatAmount: string, extra: Record<string, string> = {}) =>
  ({ taxBase, vatRate, vatAmount, equivalenceSurchargeRate: "", equivalenceSurchargeAmount: "", ...extra });

describe("vatLineProblem (F-014)", () => {
  it("completa o vacía del todo: sin problema", () => {
    expect(vatLineProblem(line("100", "21", "21"), 1)).toBeNull();
    expect(vatLineProblem(line("", "", ""), 1)).toBeNull();
    expect(vatLineProblem(line("  ", "", " "), 1)).toBeNull();
    expect(vatLineProblem(line("0", "0", "0"), 1)).toBeNull();
  });

  it("dice qué falta y en qué línea", () => {
    expect(vatLineProblem(line("50", "", "5"), 2)).toBe(
      "La línea 2 de IVA está incompleta: falta el % de IVA. Rellénala (0 si es exenta) o bórrala.",
    );
    // La exenta con solo base: antes se perdía entera.
    expect(vatLineProblem(line("50", "", ""), 1)).toBe(
      "La línea 1 de IVA está incompleta: falta el % de IVA y la cuota. Rellénala (0 si es exenta) o bórrala.",
    );
    expect(vatLineProblem(line("", "21", ""), 3)).toContain("falta la base y la cuota");
  });

  it("una línea con solo recargo tampoco es una fila vacía", () => {
    expect(vatLineProblem(line("", "", "", { equivalenceSurchargeAmount: "5.2" }), 1))
      .toContain("falta la base, el % de IVA y la cuota");
  });

  it("cuota de recargo sin su %: también incompleta", () => {
    expect(vatLineProblem(line("100", "21", "21", { equivalenceSurchargeAmount: "5.2" }), 1)).toBe(
      "La línea 1 de IVA está incompleta: tiene cuota de recargo de equivalencia pero falta su %.",
    );
  });

  it("% de recargo sin su cuota: incompleta", () => {
    expect(vatLineProblem(line("100", "21", "21", { equivalenceSurchargeRate: "5.2" }), 2)).toBe(
      "La línea 2 de IVA está incompleta: tiene % de recargo de equivalencia pero falta su cuota.",
    );
    expect(vatLineProblem(line("100", "21", "21", { equivalenceSurchargeRate: "5.2", equivalenceSurchargeAmount: "5.2" }), 1)).toBeNull();
  });

  it("más de 2 decimales: error, la BD los redondearía y el cuadre dejaría de valer", () => {
    expect(vatLineProblem(line("1.005", "21", "0.21"), 1)).toBe(
      "La línea 1 de IVA tiene más de 2 decimales en la base. Redondéalo a céntimos.",
    );
    expect(vatLineProblem(line("100", "21", "21", { equivalenceSurchargeRate: "5.2", equivalenceSurchargeAmount: "5.205" }), 1))
      .toContain("en la cuota de recargo");
    expect(vatLineProblem(line("100,50", "21", "21,11"), 1)).toBeNull();
    // Un % no se redondea a céntimos.
    expect(vatLineProblem(line("100", "21.125", "21.13"), 1)).toBe(
      "La línea 1 de IVA tiene más de 2 decimales en el % de IVA. Usa como máximo 2 decimales.",
    );
  });

  it("números sin comillas (JSON a mano) valen; lo demás es «no es un número», nunca vacío", () => {
    expect(parseVatLineInputs(JSON.stringify([{ taxBase: 100, vatRate: 21, vatAmount: 21 }]))).toEqual({
      lines: [{ taxBase: 100, vatRate: 21, vatAmount: 21, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null }],
    });
    expect(vatLineProblem({ taxBase: 100, vatRate: 21, vatAmount: true }, 1)).toBe(
      "La línea 1 de IVA tiene un valor que no es un número en la cuota.",
    );
    expect(vatLineProblem({ taxBase: "100", vatRate: "21", vatAmount: "21", equivalenceSurchargeRate: "5.2", equivalenceSurchargeAmount: "x" }, 1))
      .toBe("La línea 1 de IVA tiene un valor que no es un número en la cuota de recargo.");
  });

  it("valores que no son números", () => {
    expect(vatLineProblem(line("100", "21", "abc"), 1)).toBe(
      "La línea 1 de IVA tiene un valor que no es un número en la cuota.",
    );
    expect(vatLineProblem(line("12,5,3", "21", "1"), 1)).toContain("en la base");
  });

  it("vatLinesProblem devuelve el primero, contando la fila en pantalla", () => {
    expect(vatLinesProblem([line("100", "21", "21"), line("", "", ""), line("50", "", "5")])).toContain("La línea 3 ");
    expect(vatLinesProblem([line("100", "21", "21"), line("", "", "")])).toBeNull();
  });
});

describe("parseVatLineInputs", () => {
  it("números con coma o punto, negativos, y el recargo opcional", () => {
    const res = parseVatLineInputs(JSON.stringify([
      line("100,50", "21", "21.11"),
      line("-50", "10", "-5", { equivalenceSurchargeRate: "1,4", equivalenceSurchargeAmount: "-0.7" }),
      line("", "", ""),
    ]));
    expect(res).toEqual({ lines: [
      { taxBase: 100.5, vatRate: 21, vatAmount: 21.11, equivalenceSurchargeRate: null, equivalenceSurchargeAmount: null },
      { taxBase: -50, vatRate: 10, vatAmount: -5, equivalenceSurchargeRate: 1.4, equivalenceSurchargeAmount: -0.7 },
    ] });
  });

  it("una línea incompleta es un error, no se descarta", () => {
    // El caso de la auditoría: [100/21/21] + [50/''/5] con total 176.
    expect(parseVatLineInputs(JSON.stringify([line("100", "21", "21"), line("50", "", "5")])))
      .toEqual({ error: expect.stringContaining("La línea 2 de IVA está incompleta") });
  });

  it("vacío es ninguna línea; JSON roto o que no es una lista, un error", () => {
    expect(parseVatLineInputs("")).toEqual({ lines: [] });
    expect(parseVatLineInputs("[]")).toEqual({ lines: [] });
    expect(parseVatLineInputs("{roto")).toHaveProperty("error");
    expect(parseVatLineInputs('{"taxBase":"1"}')).toHaveProperty("error");
  });
});

describe("amountFieldsProblem (total y retención)", () => {
  it("más de 2 decimales en el total, la base, el % o la cuota de la retención", () => {
    expect(amountFieldsProblem({ totalAmount: "121.005" })).toBe("El total tiene más de 2 decimales. Redondéalo a céntimos.");
    expect(amountFieldsProblem({ retentionBase: "100.005" })).toMatch(/^La base de la retención/);
    expect(amountFieldsProblem({ retentionRate: "15.555" })).toBe("El % de retención tiene más de 2 decimales. Usa como máximo 2 decimales.");
    expect(amountFieldsProblem({ retentionAmount: "15,005" })).toMatch(/^La cuota de la retención/);
  });

  it("magnitud: «1e400» no es un número y 10.000 M€ no caben", () => {
    expect(amountFieldsProblem({ totalAmount: "1e400" })).toBe("El total no es un número.");
    expect(amountFieldsProblem({ totalAmount: "10000000000" })).toBe("El total es demasiado grande.");
    expect(amountFieldsProblem({ totalAmount: "9999999999.99" })).toBeNull();
    expect(vatLineProblem(line("1e400", "21", "21"), 1)).toBe("La línea 1 de IVA tiene un valor que no es un número en la base.");
    expect(vatLineProblem(line("10000000000", "21", "2100000000"), 1)).toBe(
      "La línea 1 de IVA tiene un importe demasiado grande en la base.",
    );
  });

  it("con 2 decimales o vacío, nada", () => {
    expect(amountFieldsProblem({ totalAmount: "121,01", retentionBase: "100", retentionRate: "15", retentionAmount: "15.05" })).toBeNull();
    expect(amountFieldsProblem({ totalAmount: "", retentionRate: " " })).toBeNull();
  });
});

describe("% entre 0 y 100 (numeric(5,2))", () => {
  it("retención", () => {
    expect(amountFieldsProblem({ retentionRate: "1500" })).toBe("El % de retención tiene que estar entre 0 y 100.");
    expect(amountFieldsProblem({ retentionRate: "-1" })).toBe("El % de retención tiene que estar entre 0 y 100.");
    expect(amountFieldsProblem({ retentionRate: "100" })).toBeNull();
    expect(amountFieldsProblem({ retentionRate: "0" })).toBeNull();
  });

  it("recargo e IVA de una línea", () => {
    expect(vatLineProblem(line("100", "21", "21", { equivalenceSurchargeRate: "1500", equivalenceSurchargeAmount: "1500" }), 1)).toBe(
      "La línea 1 de IVA tiene el % de recargo fuera de rango: tiene que estar entre 0 y 100.",
    );
    expect(vatLineProblem(line("100", "210", "210"), 2)).toBe(
      "La línea 2 de IVA tiene el % de IVA fuera de rango: tiene que estar entre 0 y 100.",
    );
    // Una rectificativa lleva los importes en negativo, no el %.
    expect(vatLineProblem(line("-100", "21", "-21"), 1)).toBeNull();
  });
});
