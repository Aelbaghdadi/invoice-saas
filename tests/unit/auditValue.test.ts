import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { auditValue, irpfAuditValue, partyAuditValue } from "@/lib/auditValue";

describe("auditValue (F-024)", () => {
  it("sin valor: null", () => {
    expect(auditValue(null)).toBeNull();
    expect(auditValue(undefined)).toBeNull();
    expect(auditValue("")).toBeNull();
  });

  it("fechas como YYYY-MM-DD", () => {
    expect(auditValue(new Date("2026-09-10T00:00:00Z"))).toBe("2026-09-10");
    expect(auditValue(new Date("x"))).toBeNull();
  });

  it("un importe da lo mismo como número, Decimal o suma con ruido", () => {
    expect(auditValue(121)).toBe("121");
    expect(auditValue(new Prisma.Decimal("121.00"))).toBe("121");
    expect(auditValue(new Prisma.Decimal("15.50"))).toBe("15.5");
    expect(auditValue(0.1 + 0.2)).toBe("0.3");
    expect(auditValue(-0)).toBe("0");
  });

  it("booleanos y texto", () => {
    expect(auditValue(true)).toBe("true");
    expect(auditValue(false)).toBe("false");
    expect(auditValue("B12345674")).toBe("B12345674");
  });
});

describe("resúmenes para las entradas auto:*", () => {
  it("retención", () => {
    expect(irpfAuditValue(15, 15.04)).toBe("15 % · 15.04");
    expect(irpfAuditValue(null, 7)).toBe("— % · 7");
    expect(irpfAuditValue(null, null)).toBeNull();
  });

  it("parte de la factura", () => {
    expect(partyAuditValue("Cliente SL", "B12345674")).toBe("Cliente SL (B12345674)");
    expect(partyAuditValue(null, null)).toBeNull();
  });
});
