// appendAuditLogs sin `db` abre su propia transaccion: tiene que aguantar mas
// que el timeout por defecto de Prisma (5 s), que miles de entradas con la BD
// cargada ya superan (revision 2 del PR #6).
import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice } from "./helpers/factories";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { appendAuditLogs, verifyFirmAuditChains } from "@/lib/auditLog";
import { signInAs } from "./helpers/session";
import { GET as verifyAudit } from "@/app/api/admin/verify-audit/route";

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

// F-048: dos escrituras a la vez sobre la misma factura leían la misma
// cabeza y dejaban dos eslabones con el mismo prevId.
describe("cadena serializada por factura (F-048)", () => {
  it("20 escrituras concurrentes dejan una cadena lineal, sin prevId repetidos", { timeout: 30_000 }, async () => {
    const w = await makeFirm("A");
    const inv = await makeInvoice(w.client);
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAuditLogs([
      { invoiceId: inv.id, userId: w.worker.id, field: "note", oldValue: null, newValue: `escritura ${i}` },
    ])));
    const rows = await prisma.auditLog.findMany({ where: { invoiceId: inv.id }, select: { id: true, prevId: true } });
    expect(rows).toHaveLength(20);
    const prevIds = rows.map((r) => r.prevId);
    expect(new Set(prevIds).size).toBe(20);
    expect(prevIds.filter((p) => p === null)).toHaveLength(1);
    // Lineal: desde el génesis se llega a los 20 siguiendo prevId.
    const next = new Map(rows.map((r) => [r.prevId, r.id]));
    let at: string | null | undefined = null;
    let length = 0;
    while ((at = next.get(at ?? null)) !== undefined) length++;
    expect(length).toBe(20);
  });
});

describe("verificación de la cadena por tandas (F-048)", () => {
  // Como demoSeed: el bypass de la migración de inmutabilidad, solo aquí.
  const tamper = (sql: string, ...values: unknown[]) => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_audit_mutation = 'true'`);
    await tx.$executeRawUnsafe(sql, ...values);
  });
  const chain = async (w: Awaited<ReturnType<typeof makeFirm>>, n: number) => {
    const inv = await makeInvoice(w.client);
    for (let i = 0; i < n; i++) {
      await appendAuditLogs([{ invoiceId: inv.id, userId: w.worker.id, field: "note", oldValue: null, newValue: `v${i}` }]);
    }
    const rows = await prisma.auditLog.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "asc" } });
    return { inv, rows };
  };

  it("íntegra, en tandas más pequeñas que la cadena; sin mirar otra asesoría", async () => {
    const w = await makeFirm("A");
    await chain(w, 7);
    await chain(w, 3);
    const b = await makeFirm("B");
    const other = await chain(b, 2);
    await tamper(`UPDATE "AuditLog" SET "newValue" = 'x' WHERE id = $1`, other.rows[1].id);
    const result = await verifyFirmAuditChains(w.firm.id, { pageSize: 2 });
    expect(result).toMatchObject({ totalInvoices: 2, intactChains: 2, brokenChains: 0, checkedRecords: 10, breaks: [] });
  });

  it("detecta un eslabón retocado", async () => {
    const w = await makeFirm("A");
    const { inv, rows } = await chain(w, 4);
    await tamper(`UPDATE "AuditLog" SET "newValue" = 'retocado' WHERE id = $1`, rows[2].id);
    const result = await verifyFirmAuditChains(w.firm.id, { pageSize: 3 });
    expect(result.brokenChains).toBe(1);
    expect(result.breaks).toEqual([expect.objectContaining({ recordId: rows[2].id, invoiceId: inv.id, reason: "hash_mismatch" })]);
  });

  it("detecta un eslabón borrado", async () => {
    const w = await makeFirm("A");
    const { rows } = await chain(w, 4);
    await tamper(`DELETE FROM "AuditLog" WHERE id = $1`, rows[1].id);
    const result = await verifyFirmAuditChains(w.firm.id);
    expect(result.breaks.map((x) => [x.recordId, x.reason])).toEqual([[rows[2].id, "broken_link"]]);
  });

  it("la ruta del botón: solo ADMIN, y el primer fallo con el número de factura", async () => {
    const w = await makeFirm("A");
    const { inv, rows } = await chain(w, 2);
    await tamper(`UPDATE "AuditLog" SET "newValue" = 'retocado' WHERE id = $1`, rows[0].id);
    signInAs(w.worker);
    expect((await verifyAudit()).status).toBe(403);
    signInAs(w.admin);
    const body = await (await verifyAudit()).json();
    expect(body.brokenChains).toBe(1);
    expect(body.firstBreak).toMatchObject({ recordId: rows[0].id, invoiceLabel: inv.invoiceNumber, reason: "hash_mismatch" });
  });

  it("detecta una bifurcación (dos eslabones con el mismo anterior)", async () => {
    const w = await makeFirm("A");
    const { rows } = await chain(w, 3);
    // Un segundo hijo del génesis, con su hash bien calculado: solo la
    // bifurcación lo delata.
    await tamper(`UPDATE "AuditLog" SET "prevId" = $1, "prevHash" = $2 WHERE id = $3`, rows[0].id, rows[0].hash, rows[2].id);
    const result = await verifyFirmAuditChains(w.firm.id);
    expect(result.breaks.map((x) => x.reason)).toContain("fork");
  });
});
