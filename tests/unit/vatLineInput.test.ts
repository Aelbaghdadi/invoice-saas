import { describe, it, expect } from "vitest";
import { parseVatLineInputs, vatLineProblem, vatLinesProblem } from "@/lib/vatLineInput";

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
