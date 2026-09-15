import { describe, it, expect } from "vitest";
import {
  accountEntryKey,
  isReliableNif,
  sameThirdParty,
  entryNameMatches,
  normalizeThirdPartyName,
  NO_RELIABLE_NIF_PREFIX,
} from "@/lib/supplierMatching";

describe("isReliableNif", () => {
  it("acepta un CIF español válido", () => {
    expect(isReliableNif("B12345674")).toBe(true);
  });

  it("acepta un VAT extranjero con prefijo reconocido", () => {
    expect(isReliableNif("PT515160873")).toBe(true);
  });

  it("acepta un VAT extranjero ya sin prefijo aunque no se conozca el país", () => {
    // Así se guardan issuerCif/receiverCif y así están las filas del plan
    // de cuentas tras normalizarlas: "515160873" tiene que seguir casando.
    expect(isReliableNif("515160873")).toBe(true);
    expect(isReliableNif("812871812")).toBe(true);
  });

  it("acepta un NIF español con la letra de control mal: identifica igual al tercero", () => {
    expect(isReliableNif("B12345678")).toBe(true);
  });

  it("rechaza vacío, null y basura", () => {
    expect(isReliableNif(null)).toBe(false);
    expect(isReliableNif("")).toBe(false);
    expect(isReliableNif("00000000")).toBe(false); // relleno
    expect(isReliableNif("NIF")).toBe(false);      // cabecera de Excel importada
    expect(isReliableNif("N/A")).toBe(false);
    expect(isReliableNif("0")).toBe(false);
  });
});

describe("accountEntryKey — identidad de tercero para el plan de cuentas", () => {
  it("usa el NIF limpio cuando es fiable (caso normal, sin cambios de comportamiento)", () => {
    expect(accountEntryKey("B-12345674", "Cualquier Nombre S.L.")).toBe("B12345674");
    expect(accountEntryKey("ES B12345674", "Cualquier Nombre S.L.")).toBe("B12345674");
  });

  it("quita el prefijo de país cuando el NIF crudo lo trae (Excel de A3, alta manual)", () => {
    expect(accountEntryKey("PT515160873", "Extraordinary Effect Lda")).toBe("515160873");
  });

  it("cae al nombre normalizado cuando el NIF es basura (proveedor chino sin VAT)", () => {
    const key = accountEntryKey("", "GUANGZHOU BLINGS BAG");
    expect(key).toBe(`${NO_RELIABLE_NIF_PREFIX}GUANGZHOU BLINGS BAG`);
  });

  it("el mismo proveedor (mismo nombre) siempre da la misma clave, insensible a formato", () => {
    const a = accountEntryKey(undefined, "Guangzhou Blings Bag");
    const b = accountEntryKey("N/A", "GUANGZHOU  BLINGS   BAG");
    expect(a).toBe(b);
  });

  it("dos proveedores distintos con el MISMO NIF basura obtienen claves distintas", () => {
    const garbageNif = "0000000";
    const keyA = accountEntryKey(garbageNif, "GUANGZHOU BLINGS BAG");
    const keyB = accountEntryKey(garbageNif, "GUANGZHOU HONGXIN COSMETICS");
    expect(keyA).not.toBe(keyB);
  });

  it("devuelve cadena vacía si no hay ni NIF fiable ni nombre utilizable", () => {
    expect(accountEntryKey("", "")).toBe("");
    expect(accountEntryKey(null, null)).toBe("");
  });

  it("una clave SINNIF: que vuelve a entrar se conserva tal cual (edición desde el plan de cuentas)", () => {
    // Antes pasaba por parseTaxId, que leía "SI" como prefijo de Eslovenia
    // y dejaba "NNIF:...": la fila dejaba de casar.
    const key = `${NO_RELIABLE_NIF_PREFIX}GUANGZHOU BLINGS BAG`;
    expect(accountEntryKey(key, "otro nombre")).toBe(key);
    expect(accountEntryKey(key.toLowerCase(), "")).toBe(key);
  });

  // Regresión real: Invoice.issuerCif/receiverCif se guardan SIN el prefijo
  // de país (p.ej. "812871812", no "DE812871812"); el país va aparte en
  // issuerCountry/receiverCountry.
  it("un NIF europeo ya limpio da la misma clave con país y sin país", () => {
    expect(accountEntryKey("812871812", "Hetzner Online GmbH", "DE")).toBe("812871812");
    expect(accountEntryKey("812871812", "Hetzner Online GmbH")).toBe("812871812");
  });

  it("con o sin prefijo en el NIF crudo, si el país es extranjero da la misma clave", () => {
    const desdeFactura = accountEntryKey("812871812", "Hetzner Online GmbH", "DE");
    const desdeAltaManual = accountEntryKey("DE812871812", "Hetzner Online GmbH");
    expect(desdeFactura).toBe(desdeAltaManual);
  });

  it("con país conocido no recorta dos veces un VAT cuyo cuerpo empieza por letras", () => {
    // Un VAT francés con clave alfabética: desde la factura llega "AT123456789"
    // con país FR. Volver a pasar por parseTaxId lo dejaba en "123456789".
    expect(accountEntryKey("AT123456789", "Société X", "FR")).toBe("AT123456789");
    expect(accountEntryKey("FRAT123456789", "Société X", "FR")).toBe("AT123456789");
  });
});

describe("normalizeThirdPartyName / sameThirdParty", () => {
  it("ignora formas jurídicas, signos y letras sueltas", () => {
    expect(normalizeThirdPartyName("Bar Pepe, S.L.")).toBe("BAR PEPE");
    expect(normalizeThirdPartyName("BAR PEPE SL")).toBe("BAR PEPE");
    expect(sameThirdParty("Bar Pepe, S.L.", "BAR PEPE SL")).toBe(true);
  });

  it("distingue a los dos proveedores chinos que comparten número", () => {
    expect(sameThirdParty("GUANGZHOU BLINGS BAG CO LTD", "GUANGZHOU HONGXIN COSMETICS AP")).toBe(false);
  });

  it("admite que un lado sea un nombre más largo del mismo tercero", () => {
    expect(sameThirdParty("ACME", "ACME Distribución S.A.")).toBe(true);
    expect(sameThirdParty("ACME DISTRIBUCION", "ACME")).toBe(true);
  });

  it("no da por iguales dos nombres que solo comparten una palabra", () => {
    expect(sameThirdParty("ACME TOOLS", "ACME FOODS")).toBe(false);
  });

  it("sin nombre en alguno de los dos lados no hay contradicción", () => {
    expect(sameThirdParty("", "ACME")).toBe(true);
    expect(sameThirdParty("ACME", null)).toBe(true);
  });
});

describe("entryNameMatches", () => {
  it("una fila aprendida sin nombre real (name == nif) encaja con cualquiera", () => {
    expect(entryNameMatches({ nif: "418306763", name: "418306763" }, "GUANGZHOU BLINGS BAG")).toBe(true);
    expect(entryNameMatches({ nif: "418306763", name: null }, "GUANGZHOU BLINGS BAG")).toBe(true);
  });

  it("una fila de otro tercero con el mismo número no encaja", () => {
    const hongxin = { nif: "418306763", name: "GUANGZHOU HONGXIN COSMETICS AP" };
    expect(entryNameMatches(hongxin, "GUANGZHOU BLINGS BAG CO LTD")).toBe(false);
    expect(entryNameMatches(hongxin, "Guangzhou Hongxin Cosmetics")).toBe(true);
  });
});
