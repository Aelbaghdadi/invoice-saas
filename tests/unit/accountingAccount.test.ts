import { describe, it, expect } from "vitest";
import {
  sanitizeAccountingAccountInput,
  padAccountingAccount,
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
