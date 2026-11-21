// Los lotes abiertos que «Subir facturas» propone, contra Postgres: lo que
// cuenta como abierto, los cierres, la ventana y las asesorías.
import { describe, it, expect, beforeEach } from "vitest";
import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { loadOpenBatches } from "@/lib/batchGroups";

// 15 de noviembre de 2026: la ventana empieza en diciembre de 2025.
const now = new Date("2026-11-15T11:00:00Z");

let w: FirmWorld;
beforeEach(async () => {
  w = await makeFirm("A");
});

const inv = (status: InvoiceStatus, periodMonth: number, extra: Record<string, unknown> = {}) =>
  makeInvoice(w.client, { status, periodMonth, periodYear: 2026, ...extra });

const exportar = async (invoiceId: string, keepPointer = true) => {
  const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
  await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId, snapshot: "{}" } });
  if (keepPointer) await prisma.invoice.update({ where: { id: invoiceId }, data: { exportBatchId: batch.id } });
};

const cerrar = (month: number, reopened = false) =>
  prisma.periodClosure.create({
    data: { clientId: w.client.id, month, year: 2026, closedBy: w.admin.id, ...(reopened ? { reopenedAt: new Date(), reopenedBy: w.admin.id } : {}) },
  });

const resumen = async (clientIds = [w.client.id], firmId: string | null = w.firm.id) =>
  (await loadOpenBatches(firmId, clientIds, now)).openBatches.map((b) =>
    `${b.periodType} ${b.periodMonth}/${b.periodYear} ${b.type}: ${b.pending} por revisar, ${b.toExport} sin exportar`);

describe("loadOpenBatches: lotes abiertos para «Subir facturas»", () => {
  it("con algo por revisar o validadas sin exportar; lo terminado, lo cerrado y lo viejo, fuera", async () => {
    // makeFirm ya deja septiembre: una por revisar y una validada sin exportar.
    await inv("PENDING_REVIEW", 10);
    await inv("OCR_ERROR", 10);
    await inv("ANALYZING", 10);
    await inv("PENDING_REVIEW", 10, { type: "SALE" });
    await inv("PENDING_REVIEW", 10, { periodType: "QUARTERLY" });
    // Agosto: todo exportado. Julio: todo rechazado. Ninguno está abierto.
    await exportar((await inv("VALIDATED", 8)).id);
    await inv("REJECTED", 7);
    // Junio: corregida después de exportarla, por reexportar: abierto.
    await exportar((await inv("VALIDATED", 6)).id, false);
    // Mayo: cerrado. Abril: cerrado y reabierto.
    await inv("PENDING_REVIEW", 5);
    await cerrar(5);
    await inv("PENDING_REVIEW", 4);
    await cerrar(4, true);
    // Marzo: solo la original de una división.
    await inv("SPLIT_SOURCE", 3);
    // Fuera de la ventana de 12 meses.
    await makeInvoice(w.client, { status: "PENDING_REVIEW", periodMonth: 3, periodYear: 2024 });

    expect(await resumen()).toEqual([
      "MONTHLY 10/2026 PURCHASE: 3 por revisar, 0 sin exportar",
      "QUARTERLY 10/2026 PURCHASE: 1 por revisar, 0 sin exportar",
      "MONTHLY 10/2026 SALE: 1 por revisar, 0 sin exportar",
      "MONTHLY 9/2026 PURCHASE: 1 por revisar, 1 sin exportar",
      "MONTHLY 6/2026 PURCHASE: 0 por revisar, 1 sin exportar",
      "MONTHLY 4/2026 PURCHASE: 1 por revisar, 0 sin exportar",
    ]);
  });

  it("solo de la asesoría: un cliente de otra no sale aunque se pida, y sin asesoría nada", async () => {
    const b = await makeFirm("B");
    expect(await resumen([b.client.id])).toEqual([]);
    expect(await resumen([w.client.id, b.client.id])).toEqual(["MONTHLY 9/2026 PURCHASE: 1 por revisar, 1 sin exportar"]);
    expect(await resumen([w.client.id], null)).toEqual([]);
    expect(await resumen([])).toEqual([]);
  });

  it("los periodos cerrados de cada cliente, para no proponerlos: ni los reabiertos, ni los de antes de la ventana, ni otra asesoría", async () => {
    await cerrar(10);
    // Un trimestre se cierra con su primer mes.
    await cerrar(7);
    await cerrar(9, true);
    await prisma.periodClosure.create({ data: { clientId: w.client.id, month: 3, year: 2024, closedBy: w.admin.id } });
    const b = await makeFirm("B");
    await prisma.periodClosure.create({ data: { clientId: b.client.id, month: 10, year: 2026, closedBy: b.admin.id } });

    const { closedPeriods } = await loadOpenBatches(w.firm.id, [w.client.id, b.client.id], now);
    expect(Object.keys(closedPeriods)).toEqual([w.client.id]);
    expect(closedPeriods[w.client.id].map((c) => `${c.month}/${c.year}`).sort()).toEqual(["10/2026", "7/2026"]);
  });

  it("la agrupación de la última subida de cada cliente, sin contar las rechazadas", async () => {
    const later = (ms: number) => new Date(Date.now() + ms);
    await inv("PENDING_REVIEW", 7, { periodType: "QUARTERLY", createdAt: later(60_000) });
    // Una mensual subida después y rechazada (subida por error): no cuenta.
    await inv("REJECTED", 10, { createdAt: later(120_000) });
    const otro = await prisma.client.create({ data: { name: "Sin facturas SL", cif: "B76543210", advisoryFirmId: w.firm.id } });

    const { lastPeriodTypes } = await loadOpenBatches(w.firm.id, [w.client.id, otro.id], now);
    expect(lastPeriodTypes).toEqual({ [w.client.id]: "QUARTERLY" });
  });
});
