import { describe, it, expect } from "vitest";
import { duplicateField, duplicateOriginalId, normalizeInvoiceNumber } from "@/lib/duplicates";

describe("normalizeInvoiceNumber (F-010)", () => {
  it("mayúsculas, sin espacios ni separadores", () => {
    for (const n of ["F-001", "F 001", "f001", "F/001", " f.001 "]) expect(normalizeInvoiceNumber(n), n).toBe("F001");
  });

  it("vacío o nulo: cadena vacía", () => {
    expect(normalizeInvoiceNumber(null)).toBe("");
    expect(normalizeInvoiceNumber(" - ")).toBe("");
  });
});

describe("duplicateField / duplicateOriginalId", () => {
  it("guardan y leen la factura original en el field de la incidencia", () => {
    expect(duplicateOriginalId(duplicateField("inv-7"))).toBe("inv-7");
    expect(duplicateOriginalId("taxBase")).toBeNull();
    expect(duplicateOriginalId(null)).toBeNull();
  });
});
