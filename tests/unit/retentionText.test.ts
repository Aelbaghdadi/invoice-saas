import { describe, it, expect } from "vitest";
import { textMentionsRetention } from "@/lib/validators";
import { partyAccountMatchesType, resultAccountMatchesType } from "@/lib/accountingAccount";

describe("textMentionsRetention", () => {
  it("detecta retencion con y sin tilde, en cualquier caja", () => {
    expect(textMentionsRetention("Retención IRPF 15%: -150,00")).toBe(true);
    expect(textMentionsRetention("RETENCION 7%")).toBe(true);
    expect(textMentionsRetention("Total retenido: 45,00")).toBe(true);
    expect(textMentionsRetention("irpf")).toBe(true);
    expect(textMentionsRetention("Base 1000,00 Ret. 7% -70,00")).toBe(true);
    expect(textMentionsRetention("Ret. (15%): -150,00")).toBe(true);
    expect(textMentionsRetention("Ret. −15 %")).toBe(true);
    // Otras «ret.» sin porcentaje no cuentan.
    expect(textMentionsRetention("Ref. pedido 123, ret. en almacén")).toBe(false);
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

describe("textMentionsRetention — protección de datos (F-073)", () => {
  it("el pie de la LOPD no es una retención de IRPF", () => {
    const lopd = "De conformidad con el RGPD, le informamos de que sus datos se conservarán durante los plazos de retención " +
      "legalmente establecidos. La retención de los datos se limitará al tiempo necesario. Política de retención: " +
      "consulte la retención de la información en nuestra web. Conservación de los datos: 5 años.";
    expect(textMentionsRetention(`Base imponible 100 IVA 21% Total 121\n${lopd}`)).toBe(false);
  });

  it("más redacciones del pie de protección de datos", () => {
    for (const phrase of [
      "la retención de su información", "la retención de tu información", "la retención de esta información",
      "el plazo legal de retención", "los plazos legales de retención", "sus datos serán retenidos",
      "plazo de conservación y retención", "el periodo máximo de retención",
      "Sus datos personales serán retenidos durante el tiempo necesario",
      "Los datos personales proporcionados serán retenidos", "La información será retenida",
    ]) {
      expect(textMentionsRetention(`Base 100 IVA 21 Total 121. ${phrase}.`), phrase).toBe(false);
    }
  });

  it("«Datos …» seguido de «Retenido»: es una retención de verdad", () => {
    expect(textMentionsRetention("Datos bancarios\nRetenido 15%: 150,00")).toBe(true);
    expect(textMentionsRetention("Datos fiscales Retenido: 150,00")).toBe(true);
  });

  it("con el pie de la LOPD, una retención de verdad se sigue viendo", () => {
    expect(textMentionsRetention("Retención IRPF 15%: -150,00\nLa retención de los datos se limitará al tiempo necesario.")).toBe(true);
    expect(textMentionsRetention("Retención 7%: -70,00\nSus datos serán retenidos durante el plazo legal de retención.")).toBe(true);
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
