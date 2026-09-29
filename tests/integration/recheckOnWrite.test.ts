// Revisión 1 del PR #15, punto 8: el reproceso masivo de «Error OCR» y
// «Descartar» vuelven a comprobar el estado al escribir. Carrera de verdad:
// otra transacción tiene la fila y la cambia antes de soltarla.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { signInAs } from "./helpers/session";
import { reprocessAllOcrErrors } from "@/app/dashboard/admin/invoices/actions";
import { discardUnclassified } from "@/app/dashboard/worker/clasificar/actions";

let w: FirmWorld;
beforeEach(async () => {
  w = await makeFirm("A");
  signInAs(w.admin);
});

const trail = async (invoiceId: string) => ({
  history: await prisma.invoiceStatusHistory.count({ where: { invoiceId } }),
  audit: await prisma.auditLog.count({ where: { invoiceId } }),
});

describe("reproceso masivo de Error OCR", () => {
  it("una que deja de estar en Error OCR mientras tanto no se toca ni deja rastro", async () => {
    const stays = await makeInvoice(w.client, { status: "OCR_ERROR" });
    const moves = await makeInvoice(w.client, { status: "OCR_ERROR" });
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, moves.id);
    const result = inFlight(reprocessAllOcrErrors());
    await expect.poll(sessionsWaitingForLock, { timeout: 10_000 }).toBe(1);
    // Otro la rechaza mientras tanto.
    await lock.release(`UPDATE "Invoice" SET status = 'REJECTED' WHERE id = $1`);
    expect(await result).toEqual({ count: 1 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: moves.id } })).status).toBe("REJECTED");
    expect(await trail(moves.id)).toEqual({ history: 0, audit: 0 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: stays.id } })).status).toBe("UPLOADED");
    expect(await trail(stays.id)).toEqual({ history: 1, audit: 1 });
  });
});

describe("Descartar al clasificar", () => {
  it("si otro la clasifica mientras tanto, error y sin rastro", async () => {
    const inv = await makeInvoice(w.client, { status: "PENDING_ROUTING", routingCandidateIds: [w.client.id] });
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, inv.id);
    const result = inFlight(discardUnclassified(inv.id));
    await expect.poll(sessionsWaitingForLock, { timeout: 10_000 }).toBe(1);
    await lock.release(`UPDATE "Invoice" SET status = 'PENDING_REVIEW' WHERE id = $1`);
    expect(await result).toEqual({ error: "La factura ya no está pendiente de clasificar." });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PENDING_REVIEW");
    expect(await trail(inv.id)).toEqual({ history: 0, audit: 0 });
  });
});
