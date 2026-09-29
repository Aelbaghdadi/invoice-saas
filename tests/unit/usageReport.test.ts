import { describe, it, expect } from "vitest";
import { usageMonths } from "@/lib/usageReport";

describe("usageMonths (F-043)", () => {
  it("del mes actual hacia atrás, cruzando el año", () => {
    expect(usageMonths(new Date("2026-02-10T10:00:00Z"), 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
  it("el mes actual es el de Madrid, no el de UTC", () => {
    // 31 de diciembre a las 23:30 UTC ya es 1 de enero en Madrid.
    expect(usageMonths(new Date("2025-12-31T23:30:00Z"), 1)).toEqual(["2026-01"]);
  });
});
