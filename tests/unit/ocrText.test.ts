import { describe, it, expect } from "vitest";
import { ocrText } from "@/lib/ocrText";

describe("ocrText", () => {
  it("quita los espacios a los lados", () => {
    expect(ocrText("  Proveedor SL ")).toBe("Proveedor SL");
  });

  it("vacío, null o la palabra «null» que escribe a veces Gemini: null", () => {
    for (const value of [null, undefined, "", "   ", "null", "NULL", " Null ", "undefined", "None", "N/A"]) {
      expect(ocrText(value)).toBeNull();
    }
  });

  it("un nombre que solo contiene esas letras no se toca", () => {
    expect(ocrText("Nulla Ediciones SL")).toBe("Nulla Ediciones SL");
    expect(ocrText(0)).toBe("0");
  });
});
