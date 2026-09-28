// Pendiente del PR #13: «Exportar (N)» en Lotes cuenta lo que marcaría la
// exportación (partitionA3Exportable), y las bloqueantes van aparte.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { exportReadiness } from "@/lib/exportReadiness";
import { POST as exportDownload } from "@/app/api/export/route";

let w: FirmWorld;
const april = { status: "VALIDATED" as const, periodMonth: 4, invoiceDate: new Date("2026-04-15") };

beforeEach(async () => {
  w = await makeFirm("A");
});

describe("exportReadiness", () => {
  it("exportables, bloqueantes aparte, y ni total 0 ni originales divididas", async () => {
    const ok = await makeInvoice(w.client, { ...april });
    const sinCuenta = await makeInvoice(w.client, { ...april, supplierAccount: null, totalAmount: 242 });
    const cero = await makeInvoice(w.client, { ...april, totalAmount: 0 });
    const original = await makeInvoice(w.client, { ...april, totalAmount: 363 });
    await makeInvoice(w.client, { ...april, status: "PENDING_REVIEW", splitFromId: original.id, totalAmount: 484 });
    const { exportable, blocked } = await exportReadiness([ok.id, sinCuenta.id, cero.id, original.id], w.firm.id);
    expect([...exportable]).toEqual([ok.id]);
    expect([...blocked]).toEqual([sinCuenta.id]);
  });

  it("el número es lo que marca la exportación", async () => {
    const ok = await makeInvoice(w.client, { ...april });
    const sinCuenta = await makeInvoice(w.client, { ...april, supplierAccount: null, totalAmount: 242 });
    const { exportable } = await exportReadiness([ok.id, sinCuenta.id], w.firm.id);
    signInAs(w.admin);
    const res = await exportDownload(new NextRequest("http://app.local/api/export", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
      body: JSON.stringify({ clientId: w.client.id, periodType: "MONTHLY", month: 4, year: 2026 }),
    }));
    expect(res.status).toBe(200);
    const marked = await prisma.invoice.findMany({ where: { exportBatchId: { not: null } }, select: { id: true } });
    expect(marked.map((m) => m.id)).toEqual([...exportable]);
  });

  it("solo con bloqueantes: nada exportable (antes, «Exportar (1)» y un 422)", async () => {
    const sinCuenta = await makeInvoice(w.client, { ...april, supplierAccount: null });
    const { exportable, blocked } = await exportReadiness([sinCuenta.id], w.firm.id);
    expect([exportable.size, blocked.size]).toEqual([0, 1]);
  });

  it("ya exportadas o de otra asesoría: fuera", async () => {
    const b = await makeFirm("B");
    const ajena = await makeInvoice(b.client, { ...april });
    const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
    const exportada = await makeInvoice(w.client, { ...april, exportBatchId: batch.id, totalAmount: 242 });
    const { exportable, blocked } = await exportReadiness([ajena.id, exportada.id], w.firm.id);
    expect([exportable.size, blocked.size]).toEqual([0, 0]);
  });
});
