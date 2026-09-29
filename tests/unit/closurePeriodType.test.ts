import { describe, it, expect } from "vitest";
import { closurePeriodType } from "@/lib/closurePeriodType";

describe("closurePeriodType (revisión 1 del PR #14, punto 14)", () => {
  it("con alguna trimestral que cuenta y un mes de inicio de trimestre, trimestral", () => {
    expect(closurePeriodType(7, [{ status: "VALIDATED", periodType: "QUARTERLY" }])).toBe("QUARTERLY");
  });

  it("una trimestral rechazada o dividida no cuenta", () => {
    expect(closurePeriodType(7, [
      { status: "REJECTED", periodType: "QUARTERLY" },
      { status: "SPLIT_SOURCE", periodType: "QUARTERLY" },
      { status: "VALIDATED", periodType: "MONTHLY" },
    ])).toBe("MONTHLY");
  });

  it("un mes que no empieza trimestre, o sin facturas: mensual", () => {
    expect(closurePeriodType(8, [{ status: "VALIDATED", periodType: "QUARTERLY" }])).toBe("MONTHLY");
    expect(closurePeriodType(4, [])).toBe("MONTHLY");
  });
});
