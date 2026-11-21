// «Mover a otro lote…» de Lotes: junta lo que se separó al subir (las de
// octubre que se subieron con «noviembre»). Contra Postgres: lo que se mueve,
// lo que se queda, los cierres, las asesorías y la auditoría.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs, signOut } from "./helpers/session";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { moveBatch } from "@/app/dashboard/worker/batch/actions";
import { POST as exportDownload } from "@/app/api/export/route";
import { verifyFirmAuditChains } from "@/lib/auditLog";

let w: FirmWorld;
beforeEach(async () => {
  w = await makeFirm("A");
  signInAs(w.worker);
});

// El lote que se separó: recibidas de noviembre de 2026, en mensual.
const NOVIEMBRE = { periodType: "MONTHLY", periodMonth: 11, periodYear: 2026, type: "PURCHASE" } as const;
type Lote = { periodType: "MONTHLY" | "QUARTERLY"; periodMonth: number; periodYear: number; type: "PURCHASE" | "SALE" };

const enLote = (status: InvoiceStatus, extra: Record<string, unknown> = {}, lote: Lote = NOVIEMBRE) =>
  makeInvoice(w.client, { ...lote, status, ...extra });

const mover = (
  to: { periodType?: "MONTHLY" | "QUARTERLY"; month: number | string; year?: number },
  from: Lote = NOVIEMBRE,
  clientId = w.client.id,
) => {
  const fd = new FormData();
  fd.set("clientId", clientId);
  fd.set("type", from.type);
  fd.set("periodType", from.periodType);
  fd.set("month", String(from.periodMonth));
  fd.set("year", String(from.periodYear));
  fd.set("toPeriodType", to.periodType ?? "MONTHLY");
  fd.set("toMonth", String(to.month));
  fd.set("toYear", String(to.year ?? 2026));
  return moveBatch(fd);
};

const loteDe = async (id: string) => {
  const r = await prisma.invoice.findUniqueOrThrow({ where: { id } });
  return `${r.periodType} ${r.periodMonth}/${r.periodYear} ${r.type}`;
};
const entradasDeLote = (invoiceId: string) =>
  prisma.auditLog.findMany({ where: { invoiceId, field: "lote" }, select: { userId: true, oldValue: true, newValue: true } });

/** Sale en un Excel: con el puntero, o corregida después (sin él). */
const exportar = async (invoiceId: string, keepPointer = true) => {
  const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
  await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId, snapshot: "{}" } });
  if (keepPointer) await prisma.invoice.update({ where: { id: invoiceId }, data: { exportBatchId: batch.id } });
};

const cerrar = (month: number, year = 2026) =>
  prisma.periodClosure.create({ data: { clientId: w.client.id, month, year, closedBy: w.admin.id } });

describe("mover un lote a otro del mismo cliente y tipo", () => {
  it("lleva todas sus facturas, deja una entrada de auditoría por factura y no toca el periodo contable", async () => {
    const pendiente = await enLote("PENDING_REVIEW");
    const validada = await enLote("VALIDATED", { accountingPeriodMonth: 11, accountingPeriodYear: 2026 });
    const rechazada = await enLote("REJECTED");
    const enOcr = await enLote("UPLOADED");
    // Otros lotes del cliente que no se tocan: emitidas de noviembre y el T4.
    const emitida = await enLote("PENDING_REVIEW", {}, { ...NOVIEMBRE, type: "SALE" });
    const trimestral = await enLote("PENDING_REVIEW", {}, { ...NOVIEMBRE, periodType: "QUARTERLY", periodMonth: 10 });

    expect(await mover({ month: 10 })).toEqual({ movidas: 4, quedan: 0 });

    for (const inv of [pendiente, validada, rechazada, enOcr]) {
      expect(await loteDe(inv.id)).toBe("MONTHLY 10/2026 PURCHASE");
      expect(await entradasDeLote(inv.id)).toEqual([
        { userId: w.worker.id, oldValue: "Noviembre 2026 · Recibidas", newValue: "Octubre 2026 · Recibidas" },
      ]);
    }
    expect(await loteDe(emitida.id)).toBe("MONTHLY 11/2026 SALE");
    expect(await loteDe(trimestral.id)).toBe("QUARTERLY 10/2026 PURCHASE");
    expect(await entradasDeLote(emitida.id)).toEqual([]);
    // El estado tampoco cambia, y el periodo contable sigue en noviembre.
    const despues = await prisma.invoice.findUniqueOrThrow({ where: { id: validada.id } });
    expect([despues.status, despues.accountingPeriodMonth, despues.accountingPeriodYear]).toEqual(["VALIDATED", 11, 2026]);
    expect((await verifyFirmAuditChains(w.firm.id)).brokenChains).toBe(0);
  });

  it("las que ya salieron en un Excel se quedan, y se dice cuántas", async () => {
    const pendiente = await enLote("PENDING_REVIEW");
    const exportada = await enLote("VALIDATED");
    await exportar(exportada.id);
    // Corregida después de exportarla: sin puntero, pero ya está en A3.
    const reexportable = await enLote("VALIDATED");
    await exportar(reexportable.id, false);
    const legacy = await enLote("EXPORTED");

    expect(await mover({ month: 10 })).toEqual({ movidas: 1, quedan: 3 });
    expect(await loteDe(pendiente.id)).toBe("MONTHLY 10/2026 PURCHASE");
    for (const inv of [exportada, reexportable, legacy]) {
      expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
      expect(await entradasDeLote(inv.id)).toEqual([]);
    }
  });

  it("con todo ya en un Excel no se mueve nada", async () => {
    const exportada = await enLote("VALIDATED");
    await exportar(exportada.id);
    expect(await mover({ month: 10 })).toEqual({ error: "Todas las facturas de este lote ya salieron en un Excel: se quedan en él." });
    expect(await loteDe(exportada.id)).toBe("MONTHLY 11/2026 PURCHASE");
  });

  it("la original de una división va con sus hijas; si sus hijas se quedan, ella también", async () => {
    const original = await enLote("SPLIT_SOURCE");
    const hija1 = await enLote("PENDING_REVIEW", { splitFromId: original.id });
    const hija2 = await enLote("VALIDATED", { splitFromId: original.id });
    const original2 = await enLote("SPLIT_SOURCE");
    const hija3 = await enLote("VALIDATED", { splitFromId: original2.id });
    await exportar(hija3.id);

    // La original no cuenta como factura (tampoco en el lote).
    expect(await mover({ month: 10 })).toEqual({ movidas: 2, quedan: 1 });
    for (const inv of [original, hija1, hija2]) expect(await loteDe(inv.id)).toBe("MONTHLY 10/2026 PURCHASE");
    for (const inv of [original2, hija3]) expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
    expect(await entradasDeLote(original.id)).toHaveLength(1);
    expect(await entradasDeLote(original2.id)).toEqual([]);
  });

  it("de mensual a trimestral: octubre al T4 (el mes se guarda como el primero del trimestre)", async () => {
    const octubre = { ...NOVIEMBRE, periodMonth: 10 };
    const inv = await enLote("PENDING_REVIEW", {}, octubre);
    expect(await mover({ periodType: "QUARTERLY", month: 11 }, octubre)).toEqual({ movidas: 1, quedan: 0 });
    expect(await loteDe(inv.id)).toBe("QUARTERLY 10/2026 PURCHASE");
    expect(await entradasDeLote(inv.id)).toEqual([
      { userId: w.worker.id, oldValue: "Octubre 2026 · Recibidas", newValue: "T4 2026 · Recibidas" },
    ]);
  });
});

describe("cierres", () => {
  it("con el periodo de origen o el de destino cerrado no se mueve nada; reabierto, sí", async () => {
    const inv = await enLote("VALIDATED");

    const noviembre = await cerrar(11);
    expect(await mover({ month: 10 })).toEqual({
      error: "El periodo de este lote (Noviembre 2026) está cerrado: pide a un administrador que lo reabra en Cierres antes de mover sus facturas.",
    });
    await prisma.periodClosure.update({ where: { id: noviembre.id }, data: { reopenedAt: new Date(), reopenedBy: w.admin.id } });

    const octubre = await cerrar(10);
    expect(await mover({ month: 10 })).toEqual({
      error: "El periodo de destino (Octubre 2026) está cerrado: pide a un administrador que lo reabra en Cierres o elige otro lote.",
    });
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
    expect(await entradasDeLote(inv.id)).toEqual([]);

    await prisma.periodClosure.update({ where: { id: octubre.id }, data: { reopenedAt: new Date(), reopenedBy: w.admin.id } });
    expect(await mover({ month: 10 })).toEqual({ movidas: 1, quedan: 0 });
  });

  it("el cierre de otro cliente no cuenta", async () => {
    const otro = await prisma.client.create({ data: { name: "Otro SL", cif: "B87654321", advisoryFirmId: w.firm.id } });
    await prisma.periodClosure.create({ data: { clientId: otro.id, month: 10, year: 2026, closedBy: w.admin.id } });
    await enLote("PENDING_REVIEW");
    expect(await mover({ month: 10 })).toEqual({ movidas: 1, quedan: 0 });
  });
});

describe("quién puede", () => {
  it("otra asesoría no mueve los lotes de esta, ni su admin ni su gestor", async () => {
    const inv = await enLote("PENDING_REVIEW");
    const b = await makeFirm("B");
    for (const user of [b.admin, b.worker]) {
      signInAs(user);
      expect(await mover({ month: 10 })).toEqual({ error: "No tienes acceso a este cliente" });
    }
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
    expect(await entradasDeLote(inv.id)).toEqual([]);
  });

  it("un gestor de la asesoría sin el cliente asignado, tampoco; el admin de la asesoría, sí", async () => {
    const inv = await enLote("PENDING_REVIEW");
    signInAs(await makeUser(w.firm.id, "WORKER", "sinasignar"));
    expect(await mover({ month: 10 })).toEqual({ error: "No tienes acceso a este cliente" });
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");

    signInAs(w.admin);
    expect(await mover({ month: 10 })).toEqual({ movidas: 1, quedan: 0 });
    expect((await entradasDeLote(inv.id)).map((e) => e.userId)).toEqual([w.admin.id]);
  });

  it("un gestor asignado a un cliente de otra asesoría no lo mueve", async () => {
    const b = await makeFirm("B");
    const ajena = await makeInvoice(b.client, { ...NOVIEMBRE, status: "PENDING_REVIEW" });
    // Una asignación que no debería existir (dato corrupto): la asesoría manda.
    await prisma.workerClientAssignment.create({ data: { workerId: w.worker.id, clientId: b.client.id } });
    expect(await mover({ month: 10 }, NOVIEMBRE, b.client.id)).toEqual({ error: "No tienes acceso a este cliente" });
    expect(await loteDe(ajena.id)).toBe("MONTHLY 11/2026 PURCHASE");
  });

  it("el buzón «Sin clasificar» no es un cliente: no se mueve", async () => {
    const buzon = await prisma.client.create({
      data: { name: "Sin clasificar", cif: "X00000000", advisoryFirmId: w.firm.id, isUnclassifiedBucket: true },
    });
    const inv = await makeInvoice(buzon, { ...NOVIEMBRE, status: "PENDING_ROUTING" });
    signInAs(w.admin);
    expect(await mover({ month: 10 }, NOVIEMBRE, buzon.id)).toEqual({ error: "No tienes acceso a este cliente" });
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
  });

  it("sin sesión, o con la de un cliente, nada", async () => {
    const inv = await enLote("PENDING_REVIEW");
    signOut();
    expect(await mover({ month: 10 })).toEqual({ error: "No autorizado" });
    signInAs(w.clientUser);
    expect(await mover({ month: 10 })).toEqual({ error: "No autorizado" });
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
  });
});

describe("con una exportación a la vez", () => {
  // Exportar las recibidas de noviembre, como la pantalla de Exportar.
  const exportarNoviembre = () => {
    signInAs(w.admin);
    return inFlight(exportDownload(new NextRequest("http://app.local/api/export", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
      body: JSON.stringify({ clientId: w.client.id, periodType: "MONTHLY", month: 11, year: 2026, type: "PURCHASE", format: "a3excel" }),
    })));
  };
  const validadaParaExportar = () => enLote("VALIDATED", { receiverName: w.client.name, receiverCif: w.client.cif });

  it("la factura que un export tiene reservada no se mueve: sale en ese Excel y se queda en su lote", async () => {
    const reservada = await validadaParaExportar();
    const pendiente = await enLote("PENDING_REVIEW");
    // El export se para después de reservar la factura, antes de crear su item.
    const lock = await holdLock('LOCK TABLE "ExportBatchItem" IN SHARE MODE');
    const exporting = exportarNoviembre();
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    // Mover la ha leído sin exportar; su UPDATE espera la fila que tiene el export.
    signInAs(w.worker);
    const moving = inFlight(mover({ month: 10 }));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(2), { timeout: 10_000 });
    await lock.release();

    expect((await exporting).status).toBe(200);
    expect(await moving).toEqual({ movidas: 1, quedan: 1 });
    expect(await loteDe(reservada.id)).toBe("MONTHLY 11/2026 PURCHASE");
    expect(await entradasDeLote(reservada.id)).toEqual([]);
    expect(await prisma.exportBatchItem.count({ where: { invoiceId: reservada.id } })).toBe(1);
    expect(await loteDe(pendiente.id)).toBe("MONTHLY 10/2026 PURCHASE");
  });

  it("si el lote se mueve mientras se genera el Excel, el export da conflicto y no se lleva la movida", async () => {
    const movida = await validadaParaExportar();
    // El export ya ha leído las de noviembre y se para al registrar el lote.
    const lock = await holdLock('LOCK TABLE "ExportBatch" IN SHARE MODE');
    const exporting = exportarNoviembre();
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    signInAs(w.worker);
    expect(await mover({ month: 10 })).toEqual({ movidas: 1, quedan: 0 });
    await lock.release();

    const res = await exporting;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "ERR-EXPORT-003" });
    expect(await prisma.exportBatch.count()).toBe(0);
    const despues = await prisma.invoice.findUniqueOrThrow({ where: { id: movida.id } });
    expect([despues.periodMonth, despues.exportBatchId]).toEqual([10, null]);
  });
});

describe("lo que no vale", () => {
  it("el mismo lote, un mes que no existe o un tipo que no es de lotes", async () => {
    const inv = await enLote("PENDING_REVIEW");
    expect(await mover({ month: 11 })).toEqual({ error: "Las facturas ya están en ese lote: elige otro." });
    expect(await mover({ month: 13 })).toEqual({ error: "Parámetros inválidos" });
    expect(await mover({ month: "" })).toEqual({ error: "Parámetros inválidos" });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ clientId: w.client.id, type: "UNKNOWN", periodType: "MONTHLY", month: "11", year: "2026", toPeriodType: "MONTHLY", toMonth: "10", toYear: "2026" })) fd.set(k, v);
    expect(await moveBatch(fd)).toEqual({ error: "Parámetros inválidos" });
    expect(await loteDe(inv.id)).toBe("MONTHLY 11/2026 PURCHASE");
  });

  it("un lote que ya no tiene facturas", async () => {
    expect(await mover({ month: 10 })).toEqual({ error: "Este lote ya no tiene facturas que mover. Recarga la página." });
  });
});
