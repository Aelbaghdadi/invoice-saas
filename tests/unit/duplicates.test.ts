import { describe, it, expect } from "vitest";
import { duplicateField, duplicateOriginalId, normalizeInvoiceNumber } from "@/lib/duplicates";

describe("normalizeInvoiceNumber (F-010)", () => {
  it("mayúsculas, sin espacios ni separadores", () => {
    for (const n of ["F-001", "F 001", "f001", "F/001", " f.001 "]) expect(normalizeInvoiceNumber(n), n).toBe("F001");
  });

  it("solo ASCII: lo demás se quita antes de pasar a mayúsculas (igual que en Postgres)", () => {
    expect(normalizeInvoiceNumber("Nº 12")).toBe("N12");
    expect(normalizeInvoiceNumber("ß-1")).toBe("1");
    expect(normalizeInvoiceNumber("ﬁ-2")).toBe("2");
    expect(normalizeInvoiceNumber("ı-3")).toBe("3");
    expect(normalizeInvoiceNumber("Ñ-4")).toBe("4");
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
