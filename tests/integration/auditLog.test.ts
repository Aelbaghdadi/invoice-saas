// appendAuditLogs sin `db` abre su propia transaccion: tiene que aguantar mas
// que el timeout por defecto de Prisma (5 s), que miles de entradas con la BD
// cargada ya superan (revision 2 del PR #6).
import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice } from "./helpers/factories";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { appendAuditLogs } from "@/lib/auditLog";

describe("appendAuditLogs con su propia transacción", () => {
  it("aguanta más de 5 s parada sin perder la transacción", { timeout: 30_000 }, async () => {
    const w = await makeFirm("A");
    const inv = await makeInvoice(w.client);
    // El INSERT de la auditoria espera al bloqueo: la transaccion de
    // appendAuditLogs sigue abierta mientras tanto.
    const lock = await holdLock('LOCK TABLE "AuditLog" IN SHARE MODE');
    const t0 = Date.now();
    const appending = inFlight(appendAuditLogs([
      { invoiceId: inv.id, userId: w.worker.id, field: "status", oldValue: "PENDING_REVIEW", newValue: "VALIDATED" },
    ]));
    await expect.poll(sessionsWaitingForLock, { timeout: 10_000 }).toBe(1);
    // Aqui el tiempo es lo que se prueba: pasar de los 5 s por defecto.
    await new Promise((resolve) => setTimeout(resolve, 6_000 - (Date.now() - t0)));
    await lock.release();
    await expect(appending).resolves.toBeUndefined();
    expect(await prisma.auditLog.count({ where: { invoiceId: inv.id } })).toBe(1);
  });
});
