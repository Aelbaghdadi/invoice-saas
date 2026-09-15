import { describe, it, expect } from "vitest";
import { accountEntryKey, isReliableNif, NO_RELIABLE_NIF_PREFIX } from "@/lib/supplierMatching";

describe("isReliableNif", () => {
  it("acepta un CIF español válido", () => {
    expect(isReliableNif("B12345674")).toBe(true);
  });

  it("acepta un VAT extranjero con prefijo reconocido", () => {
    expect(isReliableNif("PT515160873")).toBe(true);
  });

  it("rechaza vacio, null o basura sin prefijo reconocible", () => {
    expect(isReliableNif(null)).toBe(false);
    expect(isReliableNif("")).toBe(false);
    expect(isReliableNif("00000000")).toBe(false); // 8 digitos, sin letra de control valida
  });
});

describe("accountEntryKey — identidad de tercero para el plan de cuentas", () => {
  it("usa el NIF limpio cuando es fiable (caso normal, sin cambios de comportamiento)", () => {
    expect(accountEntryKey("B-12345674", "Cualquier Nombre S.L.")).toBe("B12345674");
    expect(accountEntryKey("ES B12345674", "Cualquier Nombre S.L.")).toBe("B12345674");
  });

  it("cae al nombre normalizado cuando el NIF no es fiable (proveedor chino sin VAT valido)", () => {
    const key = accountEntryKey("", "GUANGZHOU BLINGS BAG");
    expect(key).toBe(`${NO_RELIABLE_NIF_PREFIX}GUANGZHOU BLINGS BAG`);
  });

  it("el mismo proveedor (mismo nombre) siempre da la misma clave, insensible a formato", () => {
    const a = accountEntryKey(undefined, "Guangzhou Blings Bag");
    const b = accountEntryKey("N/A", "GUANGZHOU  BLINGS   BAG");
    expect(a).toBe(b);
  });

  // CASO 8: dos proveedores distintos que comparten un identificador fiscal
  // no fiable NO deben acabar fusionados en la misma fila del plan de cuentas.
  it("dos proveedores distintos con el MISMO NIF basura obtienen claves distintas", () => {
    const garbageNif = "0000000A"; // no valida como NIF/CIF español
    const keyA = accountEntryKey(garbageNif, "GUANGZHOU BLINGS BAG");
    const keyB = accountEntryKey(garbageNif, "GUANGZHOU HONGXIN COSMETICS");
    expect(keyA).not.toBe(keyB);
  });

  it("devuelve cadena vacia si no hay ni NIF fiable ni nombre utilizable", () => {
    expect(accountEntryKey("", "")).toBe("");
    expect(accountEntryKey(null, null)).toBe("");
  });

  // Regresión real: Invoice.issuerCif/receiverCif se guardan SIN el prefijo
  // de país (p.ej. "812871812", no "DE812871812"); el país va aparte en
  // issuerCountry/receiverCountry. Sin pasar ese país, un VAT alemán
  // perfectamente real se intentaba validar como NIF español, fallaba el
  // dígito de control, y un proveedor con NIF correcto en el plan de
  // cuentas (ej. Hetzner) seguía saliendo como "no encontrado".
  it("un NIF europeo ya limpio (sin prefijo) es fiable si se conoce el país por separado", () => {
    const conPais = accountEntryKey("812871812", "Hetzner Online GmbH", "DE");
    expect(conPais).toBe("812871812");
  });

  it("sin el país, ese mismo NIF limpio se trataría (mal) como no fiable y caería al nombre", () => {
    const sinPais = accountEntryKey("812871812", "Hetzner Online GmbH");
    expect(sinPais).toBe(`${NO_RELIABLE_NIF_PREFIX}HETZNER ONLINE GMBH`);
  });

  it("con o sin prefijo en el NIF crudo, si el país es extranjero da la misma clave", () => {
    const desdeFactura = accountEntryKey("812871812", "Hetzner Online GmbH", "DE");
    const desdeAltaManual = accountEntryKey("DE812871812", "Hetzner Online GmbH");
    expect(desdeFactura).toBe(desdeAltaManual);
  });
});
