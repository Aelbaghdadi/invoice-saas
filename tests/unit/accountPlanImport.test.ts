import { describe, it, expect } from "vitest";
import { groupPlanRows } from "@/lib/accountPlanImport";

const header = ["Cuenta", "Descripción", "NIF"];

describe("groupPlanRows — importación del plan de cuentas", () => {
  it("junta en una entrada la cuenta de proveedor y la de gasto del mismo tercero", () => {
    const { entries, errors } = groupPlanRows([
      header,
      ["40000001", "SUMINISTROS PEPE SL", "B12345674"],
      ["60000001", "SUMINISTROS PEPE SL", "B12345674"],
    ]);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { nif: "B12345674", name: "SUMINISTROS PEPE SL", supplierAccount: "40000001", customerAccount: "", expenseAccount: "60000001", incomeAccount: "" },
    ]);
  });

  it("no junta a dos terceros distintos que comparten número (Blings Bag / Hongxin), en ningún orden", () => {
    const blings = ["40000046", "GUANGZHOU BLINGS BAG CO LTD", "CN418306763"];
    const hongxin = ["41000192", "GUANGZHOU HONGXIN COSMETICS AP", "418306763"];
    for (const rows of [[header, blings, hongxin], [header, hongxin, blings]]) {
      const { entries, errors } = groupPlanRows(rows);
      expect(entries.find((e) => e.nif === "418306763")).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("NIF 418306763");
      expect(errors[0]).toContain("40000046");
      expect(errors[0]).toContain("41000192");
    }
  });

  it("el conflicto de un número no impide importar el resto del plan", () => {
    const { entries } = groupPlanRows([
      header,
      ["40000046", "GUANGZHOU BLINGS BAG CO LTD", "CN418306763"],
      ["41000192", "GUANGZHOU HONGXIN COSMETICS AP", "418306763"],
      ["40000001", "SUMINISTROS PEPE SL", "B12345674"],
    ]);
    expect(entries.map((e) => e.nif)).toEqual(["B12345674"]);
  });

  it("el mismo tercero con el nombre escrito de otra forma y la misma cuenta sigue siendo uno", () => {
    const { entries, errors } = groupPlanRows([
      header,
      ["41000192", "GUANGZHOU HONGXIN COSMETICS AP", "418306763"],
      ["41000192", "Guangzhou Hongxin Cosmetics Co Ltd", "418306763"],
    ]);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].supplierAccount).toBe("41000192");
  });

  it("el mismo nombre con otra subcuenta no es conflicto: gana la última, como antes", () => {
    const { entries, errors } = groupPlanRows([
      header,
      ["40000001", "SUMINISTROS PEPE SL", "B12345674"],
      ["40000002", "Suministros Pepe, S.L.", "B12345674"],
    ]);
    expect(errors).toEqual([]);
    expect(entries[0].supplierAccount).toBe("40000002");
  });

  it("sin NIF solo entra una cuenta de tercero, identificada por el nombre", () => {
    const { entries } = groupPlanRows([
      header,
      ["62900000", "Otros servicios", ""],
      ["40000099", "PROVEEDOR CHINO SIN VAT", ""],
    ]);
    expect(entries).toEqual([
      { nif: "SINNIF:PROVEEDOR CHINO SIN VAT", name: "PROVEEDOR CHINO SIN VAT", supplierAccount: "40000099", customerAccount: "", expenseAccount: "", incomeAccount: "" },
    ]);
  });

  it("el mismo tercero como cliente y como proveedor guarda las dos cuentas (caso FARMACIA AGUACATE)", () => {
    const { entries, errors } = groupPlanRows([
      header,
      ["41000486", "FARMACIA AGUACATE CB", "E87329710"],
      ["43000053", "FARMACIA AGUACATE CB", "E87329710"],
      ["62900000", "FARMACIA AGUACATE CB", "E87329710"],
      ["70000000", "FARMACIA AGUACATE CB", "E87329710"],
    ]);
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      {
        nif: "E87329710", name: "FARMACIA AGUACATE CB",
        supplierAccount: "41000486", customerAccount: "43000053",
        expenseAccount: "62900000", incomeAccount: "70000000",
      },
    ]);
  });

  it("dar la vuelta al Excel no cambia el resultado: ya no gana la ultima fila", () => {
    const { entries } = groupPlanRows([
      header,
      ["43000053", "FARMACIA AGUACATE CB", "E87329710"],
      ["41000486", "FARMACIA AGUACATE CB", "E87329710"],
    ]);
    expect(entries[0].supplierAccount).toBe("41000486");
    expect(entries[0].customerAccount).toBe("43000053");
  });

  it("dos terceros distintos con el mismo numero siguen siendo conflicto dentro de su familia", () => {
    const { entries, errors } = groupPlanRows([
      header,
      ["40000046", "GUANGZHOU BLINGS BAG CO LTD", "CN418306763"],
      ["41000192", "GUANGZHOU HONGXIN COSMETICS AP", "418306763"],
    ]);
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("una 44x sin sentido claro se queda en la cuenta de proveedor", () => {
    const { entries } = groupPlanRows([
      header,
      ["44000001", "DEUDOR VARIOS SL", "B12345674"],
    ]);
    expect(entries[0].supplierAccount).toBe("44000001");
    expect(entries[0].customerAccount).toBe("");
  });

  it("avisa de una cuenta guardada como número con decimales y no la importa", () => {
    const { entries, errors } = groupPlanRows([header, [430.1, "CLIENTE X", "B12345674"]]);
    expect(entries).toEqual([]);
    expect(errors[0]).toContain("Fila 2");
  });
});
