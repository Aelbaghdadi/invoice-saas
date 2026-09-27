// «Reset demo»: las validadas de la demo tienen que poder exportarse (F-025:
// sin cuentas son bloqueantes).
import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm } from "./helpers/factories";
import { reseedDemo } from "@/lib/demoSeed";
import { validateForA3Export, type InvoiceWithClient } from "@/lib/exportFormats";

describe("Reset demo", () => {
  it("las validadas sembradas llevan cuentas y no tienen nada bloqueante para el export", async () => {
    const w = await makeFirm("A");
    const res = await reseedDemo(w.firm.id, w.admin.id);
    expect(res.ok).toBe(true);
    const validated = await prisma.invoice.findMany({
      where: { client: { advisoryFirmId: w.firm.id }, status: "VALIDATED" },
      include: { client: true, vatLines: { orderBy: { position: "asc" } } },
    });
    expect(validated.length).toBeGreaterThan(0);
    for (const inv of validated) {
      expect([inv.supplierAccount, inv.expenseAccount].every(Boolean)).toBe(true);
    }
    const blocked = validateForA3Export(validated as InvoiceWithClient[]).filter((r) => r.severity === "bloqueante");
    expect(blocked).toEqual([]);
  });
});
