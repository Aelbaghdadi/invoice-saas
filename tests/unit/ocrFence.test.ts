import { describe, it, expect } from "vitest";
import { MAX_OCR_RETRIES, ocrFenceWhere, stuckAnalyzingWhere } from "@/lib/invoiceStatuses";

describe("ocrFenceWhere", () => {
  it("exige ANALYZING y el ocrAttempts del claim", () => {
    expect(ocrFenceWhere("inv1", 2)).toEqual({ id: "inv1", status: "ANALYZING", ocrAttempts: 2 });
  });

  it("un claim posterior (otro ocrAttempts) deja fuera a la ejecución anterior", () => {
    expect(ocrFenceWhere("inv1", 2)).not.toEqual(ocrFenceWhere("inv1", 3));
  });
});

describe("stuckAnalyzingWhere", () => {
  it("solo ANALYZING sin tocar desde el corte y con intentos pendientes", () => {
    const cutoff = new Date("2026-09-26T10:00:00Z");
    expect(stuckAnalyzingWhere(cutoff)).toEqual({
      status: "ANALYZING",
      updatedAt: { lt: cutoff },
      ocrAttempts: { lt: MAX_OCR_RETRIES },
    });
  });
});
