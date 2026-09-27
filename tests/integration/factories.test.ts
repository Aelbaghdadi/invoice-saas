import { describe, it, expect } from "vitest";
import { makeTwoFirms } from "./helpers/factories";
import { prisma } from "./helpers/db";
import { signInAs } from "./helpers/session";
import { canAccessClient } from "@/lib/accessibleClients";
import { auth } from "@/lib/auth";

describe("factorías: dos asesorías", () => {
  it("cada una con admin, gestor asignado, cliente con portal y facturas", async () => {
    const { a, b } = await makeTwoFirms();
    for (const w of [a, b]) {
      expect(w.admin.advisoryFirmId).toBe(w.firm.id);
      expect(w.worker.advisoryFirmId).toBe(w.firm.id);
      const client = await prisma.client.findUniqueOrThrow({ where: { id: w.client.id }, include: { assignedWorkers: true } });
      expect(client.advisoryFirmId).toBe(w.firm.id);
      expect(client.userId).toBe(w.clientUser.id);
      expect(client.assignedWorkers.map((x) => x.workerId)).toEqual([w.worker.id]);
      expect(await prisma.invoice.count({ where: { clientId: w.client.id } })).toBe(2);
    }
    expect(a.firm.id).not.toBe(b.firm.id);
  });

  it("sirven para tests de aislamiento: el admin de A no llega al cliente de B", async () => {
    const { a, b } = await makeTwoFirms();
    signInAs(a.admin);
    const session = await auth();
    expect(await canAccessClient(session!, a.client.id)).toBe(true);
    expect(await canAccessClient(session!, b.client.id)).toBe(false);
    signInAs(a.worker);
    expect(await canAccessClient((await auth())!, b.client.id)).toBe(false);
  });
});
