import { describe, it, expect } from "vitest";
import { normalizePlanAccount, accountGroup } from "@/lib/accountingAccount";

describe("normalizePlanAccount", () => {
  it("expande las cuentas con punto a 8 dígitos sin punto", () => {
    expect(normalizePlanAccount("430.00001")).toBe("43000001");
    expect(normalizePlanAccount("400.22")).toBe("40000022");
  });

  it("deja tal cual las cuentas sin punto, sea cual sea su largo", () => {
    expect(normalizePlanAccount("40000022")).toBe("40000022");
    expect(normalizePlanAccount("4000001")).toBe("4000001");
  });

  it("recorta espacios", () => {
    expect(normalizePlanAccount("  62900000 ")).toBe("62900000");
  });
});

describe("accountGroup", () => {
  it("toma los tres primeros dígitos, con punto o sin él", () => {
    expect(accountGroup("40000022")).toBe(400);
    expect(accountGroup("430.00001")).toBe(430);
    expect(accountGroup("62900000")).toBe(629);
  });

  it("devuelve null si no hay tres dígitos", () => {
    expect(accountGroup("")).toBeNull();
    expect(accountGroup("4")).toBeNull();
  });
});
