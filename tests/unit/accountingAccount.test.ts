import { describe, it, expect } from "vitest";
import {
  sanitizeAccountingAccountInput,
  padAccountingAccount,
  accountsForDirection,
  learnAccountsForDirection,
} from "@/lib/accountingAccount";

/** Simula teclear caracter a caracter, que es como lo aplica el onChange del formulario. */
function teclear(texto: string): string {
  let valor = "";
  for (const char of texto) valor = sanitizeAccountingAccountInput(valor + char);
  return valor;
}

describe("sanitizeAccountingAccountInput", () => {
  it("corta al llegar a 8 digitos", () => {
    expect(teclear("123456789")).toBe("12345678");
  });

  it("admite un unico punto separador", () => {
    expect(teclear("4.2.2")).toBe("4.22");
  });

  it("ignora letras, comas y espacios", () => {
    expect(teclear("600,5")).toBe("6005");
    expect(teclear("4 30x")).toBe("430");
  });

  it("cuenta solo digitos para el limite, no el punto", () => {
    expect(teclear("430.00001")).toBe("430.00001");
  });
});

describe("padAccountingAccount", () => {
  it("rellena a la derecha cuando no hay punto", () => {
    expect(padAccountingAccount("600")).toBe("60000000");
    expect(padAccountingAccount("4")).toBe("40000000");
  });

  it("deja la subcuenta pegada al final cuando hay punto", () => {
    expect(padAccountingAccount("4.22")).toBe("40000022");
    expect(padAccountingAccount("430.1")).toBe("43000001");
  });

  it("no conserva el punto en el valor final", () => {
    expect(padAccountingAccount("430.00001")).not.toContain(".");
  });

  it("trata el punto final como cuenta sin subcuenta", () => {
    expect(padAccountingAccount("600.")).toBe("60000000");
  });

  it("deja intacta una cuenta que ya tiene 8 digitos", () => {
    expect(padAccountingAccount("40000022")).toBe("40000022");
  });

  it("devuelve vacio si no hay ningun digito", () => {
    expect(padAccountingAccount("")).toBe("");
    expect(padAccountingAccount(".")).toBe("");
  });

  it("siempre produce 8 digitos exactos partiendo de una entrada valida", () => {
    for (const entrada of ["6", "600", "4.22", "430.1", "1.1", "12345678"]) {
      expect(padAccountingAccount(teclear(entrada))).toMatch(/^\d{8}$/);
    }
  });
});

const ficha = {
  supplierAccount: "41000486",
  customerAccount: "43000053",
  expenseAccount: "62900000",
  incomeAccount: "70000000",
};

describe("accountsForDirection", () => {
  it("en una compra da la pareja de proveedor", () => {
    expect(accountsForDirection(ficha, "PURCHASE")).toEqual({ party: "41000486", result: "62900000" });
  });

  it("en una venta da la pareja de cliente del MISMO tercero", () => {
    expect(accountsForDirection(ficha, "SALE")).toEqual({ party: "43000053", result: "70000000" });
  });

  it("sin cuenta para ese sentido devuelve vacio, no la del otro", () => {
    const soloCompras = { ...ficha, customerAccount: "", incomeAccount: "" };
    expect(accountsForDirection(soloCompras, "SALE")).toEqual({ party: "", result: "" });
  });

  it("sin ficha no revienta", () => {
    expect(accountsForDirection(null, "PURCHASE")).toEqual({ party: "", result: "" });
  });
});

describe("learnAccountsForDirection", () => {
  it("una compra se aprende en las columnas de proveedor", () => {
    expect(learnAccountsForDirection("41000486", "62900000", "PURCHASE"))
      .toEqual({ supplierAccount: "41000486", expenseAccount: "62900000" });
  });

  it("una venta se aprende en las columnas de cliente", () => {
    expect(learnAccountsForDirection("43000053", "70000000", "SALE"))
      .toEqual({ customerAccount: "43000053", incomeAccount: "70000000" });
  });

  it("no aprende una cuenta de la familia contraria (43x tecleada en una compra)", () => {
    expect(learnAccountsForDirection("43000053", "62900000", "PURCHASE"))
      .toEqual({ expenseAccount: "62900000" });
  });

  it("no aprende un gasto 6xx en una venta", () => {
    expect(learnAccountsForDirection("43000053", "62900000", "SALE"))
      .toEqual({ customerAccount: "43000053" });
  });

  it("una contrapartida de inmovilizado 2xx si se aprende en una compra", () => {
    expect(learnAccountsForDirection("", "21300000", "PURCHASE"))
      .toEqual({ expenseAccount: "21300000" });
  });

  it("vacio no aprende nada", () => {
    expect(learnAccountsForDirection("", "", "PURCHASE")).toEqual({});
  });
});
