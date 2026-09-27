// «Reset demo»: las validadas de la demo tienen que poder exportarse (F-025:
// sin cuentas son bloqueantes).
import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm } from "./helpers/factories";
import { reseedDemo } from "@/lib/demoSeed";
import { isValidNIF } from "@/lib/validators";
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

  it("todos los NIF sembrados son válidos (el de Repsol tenía mal el dígito de control)", async () => {
    const w = await makeFirm("A");
    expect((await reseedDemo(w.firm.id, w.admin.id)).ok).toBe(true);
    const invoices = await prisma.invoice.findMany({
      where: { client: { advisoryFirmId: w.firm.id } }, select: { issuerCif: true, receiverCif: true },
    });
    const entries = await prisma.accountEntry.findMany({ where: { client: { advisoryFirmId: w.firm.id } }, select: { nif: true } });
    const nifs = [...invoices.flatMap((i) => [i.issuerCif, i.receiverCif]), ...entries.map((e) => e.nif)].filter(Boolean) as string[];
    expect(nifs.length).toBeGreaterThan(0);
    expect(nifs.filter((n) => !isValidNIF(n))).toEqual([]);
  });
});
