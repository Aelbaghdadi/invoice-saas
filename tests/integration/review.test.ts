// Revision (PR #4, F-015/F-008): estados de origen en el propio UPDATE y
// «Reabrir y validar».
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { signInAs } from "./helpers/session";
import { reject, reviewForm, validate } from "./helpers/reviewForm";
import { reviewTargetWhere } from "@/lib/invoiceStatuses";

let w: FirmWorld;
let id: string;
const A = () => prisma.invoice.findUniqueOrThrow({ where: { id } });
const reopenA = async () => validate(reviewForm(id, (await A()).updatedAt, w.client, { reopen: "1" }));

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client, { status: "REJECTED", rejectionReason: "Ilegible", rejectionCategory: "ILLEGIBLE" }));
  signInAs(w.worker);
});

describe("estados de origen en guardar, validar y rechazar", () => {
  it("validar una que se está analizando: { error } y no cambia", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "ANALYZING", rejectionReason: null } });
    const r = await validate(reviewForm(id, (await A()).updatedAt, w.client));
    expect(String(r.error)).toMatch(/analizando/);
    expect((await A()).status).toBe("ANALYZING");
  });

  it("validar cruzado con una división (bloqueo de fila): el UPDATE condicionado no valida la SPLIT_SOURCE", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "PENDING_REVIEW", rejectionReason: null } });
    const leido = (await A()).updatedAt;
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, id);
    const pending = inFlight(validate(reviewForm(id, leido, w.client)));
    // La comprobacion previa ya paso (era PENDING_REVIEW) y el UPDATE espera la fila.
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    await lock.release(`UPDATE "Invoice" SET status = 'SPLIT_SOURCE' WHERE id = $1`);
    const r = await pending;
    expect(String(r.error)).toMatch(/dividió en otras/);
    expect((await A()).status).toBe("SPLIT_SOURCE");
  });

  it("rechazar cruzado con un reproceso (pasa a ANALYZING): no se rechaza", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "PENDING_REVIEW", rejectionReason: null } });
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, id);
    const pending = inFlight(reject(id));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    await lock.release(`UPDATE "Invoice" SET status = 'ANALYZING' WHERE id = $1`);
    const r = await pending;
    expect(String(r.error)).toMatch(/analizando/);
    expect((await A()).status).toBe("ANALYZING");
  });

  it("una rechazada no se valida sin «Reabrir y validar»", async () => {
    const r = await validate(reviewForm(id, (await A()).updatedAt, w.client));
    expect(String(r.error)).toMatch(/Reabrir y validar/);
    expect((await A()).status).toBe("REJECTED");
  });
});

describe("«Reabrir y validar»", () => {
  it("sin sustituta: la reabre, la valida y borra el motivo, con historial y auditoría", async () => {
    expect((await reopenA()).error).toBeNull();
    const a = await A();
    expect(a.status).toBe("VALIDATED");
    expect(a.rejectionReason).toBeNull();
    const history = await prisma.invoiceStatusHistory.findMany({ where: { invoiceId: id } });
    expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual(["REJECTED->VALIDATED"]);
    const audit = await prisma.auditLog.findMany({ where: { invoiceId: id } });
    expect(audit.map((x) => x.field)).toEqual(expect.arrayContaining(["status", "rejectionReason"]));
    expect(audit.find((x) => x.field === "rejectionCategory")?.oldValue).toBe("ILLEGIBLE");
  });

  it("con una versión corregida del cliente: no se reabre (también en el propio UPDATE)", async () => {
    const b = await makeInvoice(w.client, { status: "VALIDATED", replacesId: id });
    expect((await reopenA()).error).toBe("El cliente ya subió una versión corregida de esta factura: valida esa en su lugar.");
    expect((await A()).status).toBe("REJECTED");
    const where = { id, ...reviewTargetWhere("validate", { reopen: true }) };
    expect((await prisma.invoice.updateMany({ where, data: { status: "VALIDATED" } })).count).toBe(0);
    await prisma.invoice.delete({ where: { id: b.id } });
    expect((await prisma.invoice.updateMany({ where, data: { status: "VALIDATED" } })).count).toBe(1);
  });

  it("una descartada al clasificar («Sin clasificar») no se valida (también en el propio UPDATE)", async () => {
    const bucket = await prisma.client.create({
      data: { name: "Sin clasificar", cif: "X0000000X", advisoryFirmId: w.firm.id, isUnclassifiedBucket: true },
    });
    await prisma.invoice.update({ where: { id }, data: { clientId: bucket.id } });
    signInAs(w.admin);
    expect((await reopenA()).error).toBe("Esta factura está en «Sin clasificar» y no tiene cliente: no se puede validar.");
    expect((await A()).status).toBe("REJECTED");
    const where = { id, ...reviewTargetWhere("validate", { reopen: true }) };
    expect((await prisma.invoice.updateMany({ where, data: { status: "VALIDATED" } })).count).toBe(0);
  });

  it("si la auditoría falla, no queda reabierta a medias", async () => {
    // Sin DDL: un ADMIN de la asesoria cuyo usuario no existe. El acceso se
    // decide por la asesoria, y AuditLog.userId (FK a User) falla dentro de
    // la transaccion.
    signInAs({ id: "usuario-que-no-existe", role: "ADMIN", advisoryFirmId: w.firm.id });
    // Error del sistema al escribir (no un «no tienes acceso»).
    expect((await reopenA()).error).toMatchObject({ code: "ERR-SYS-001" });
    const a = await A();
    expect(a.status).toBe("REJECTED");
    expect(a.rejectionReason).toBe("Ilegible");
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("el gestor de otra asesoría no la puede reabrir", async () => {
    const b = await makeFirm("B");
    signInAs(b.worker);
    expect((await reopenA()).error).toBeTruthy();
    expect((await A()).status).toBe("REJECTED");
  });
});
