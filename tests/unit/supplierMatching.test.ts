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
});
