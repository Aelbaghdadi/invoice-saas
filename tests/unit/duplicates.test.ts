import { describe, it, expect } from "vitest";
import { normalizeInvoiceNumber } from "@/lib/duplicates";

describe("normalizeInvoiceNumber (F-010)", () => {
  it("mayúsculas, sin espacios ni separadores", () => {
    for (const n of ["F-001", "F 001", "f001", "F/001", " f.001 "]) expect(normalizeInvoiceNumber(n), n).toBe("F001");
  });

  it("vacío o nulo: cadena vacía", () => {
    expect(normalizeInvoiceNumber(null)).toBe("");
    expect(normalizeInvoiceNumber(" - ")).toBe("");
  });
});
