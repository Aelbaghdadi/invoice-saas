import { describe, it, expect } from "vitest";
import { textMentionsRetention } from "@/lib/validators";
import { partyAccountMatchesType, resultAccountMatchesType } from "@/lib/accountingAccount";

describe("textMentionsRetention", () => {
  it("detecta retencion con y sin tilde, en cualquier caja", () => {
    expect(textMentionsRetention("Retención IRPF 15%: -150,00")).toBe(true);
    expect(textMentionsRetention("RETENCION 7%")).toBe(true);
    expect(textMentionsRetention("Total retenido: 45,00")).toBe(true);
    expect(textMentionsRetention("irpf")).toBe(true);
  });

  it("no detecta una factura normal", () => {
    expect(textMentionsRetention("Base imponible 100 IVA 21% Total 121")).toBe(false);
    expect(textMentionsRetention("")).toBe(false);
    expect(textMentionsRetention(null)).toBe(false);
  });

  it("no confunde palabras que contienen las letras sueltas", () => {
    expect(textMentionsRetention("Servicios de mantenimiento")).toBe(false);
  });
});

describe("familia de cuenta segun el sentido", () => {
  it("la cuenta de tercero: 40x/41x en compras, 43x en ventas", () => {
    expect(partyAccountMatchesType("40000001", "PURCHASE")).toBe(true);
    expect(partyAccountMatchesType("41000001", "PURCHASE")).toBe(true);
    expect(partyAccountMatchesType("43000001", "PURCHASE")).toBe(false);
    expect(partyAccountMatchesType("43000001", "SALE")).toBe(true);
    expect(partyAccountMatchesType("40000001", "SALE")).toBe(false);
  });

  it("la cuenta de resultado: 6xx en compras, 7xx en ventas", () => {
    expect(resultAccountMatchesType("62900000", "PURCHASE")).toBe(true);
    expect(resultAccountMatchesType("70000000", "PURCHASE")).toBe(false);
    expect(resultAccountMatchesType("70000000", "SALE")).toBe(true);
    expect(resultAccountMatchesType("62900000", "SALE")).toBe(false);
  });

  it("vacio nunca casa (no sugerimos nada)", () => {
    expect(partyAccountMatchesType("", "SALE")).toBe(false);
    expect(resultAccountMatchesType(null, "PURCHASE")).toBe(false);
  });
});

describe("textMentionsRetention — negaciones (falsos positivos del 15%)", () => {
  it("no cuenta las menciones negadas", () => {
    expect(textMentionsRetention("Operación sin retención")).toBe(false);
    expect(textMentionsRetention("Factura no sujeta a retención")).toBe(false);
    expect(textMentionsRetention("Exento de retenciones")).toBe(false);
  });

  it("sigue detectando la retención de verdad aunque el texto sea largo", () => {
    expect(textMentionsRetention("Base 1000\nRetención IRPF 15%: -150,00\nTotal 1060")).toBe(true);
  });

  it("si convive una negación con una retención real, gana la real", () => {
    expect(textMentionsRetention("Servicios sin retención de garantía. Retención IRPF 7%: -70,00")).toBe(true);
  });
});

describe("familias de cuenta — no descartar cuentas legítimas fuera de 4xx/6xx/7xx", () => {
  it("acepta inmovilizado 2xx y existencias 3xx como contrapartida de compra", () => {
    expect(resultAccountMatchesType("21700000", "PURCHASE")).toBe(true);
    expect(resultAccountMatchesType("30000000", "PURCHASE")).toBe(true);
  });

  it("acepta deudores 44x como cuenta de tercero en una venta", () => {
    expect(partyAccountMatchesType("44000001", "SALE")).toBe(true);
  });

  it("pero sigue rechazando la familia del sentido contrario", () => {
    expect(partyAccountMatchesType("43000001", "PURCHASE")).toBe(false);
    expect(partyAccountMatchesType("40000001", "SALE")).toBe(false);
    expect(resultAccountMatchesType("70000000", "PURCHASE")).toBe(false);
    expect(resultAccountMatchesType("62900000", "SALE")).toBe(false);
  });
});
