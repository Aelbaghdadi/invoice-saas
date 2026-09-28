// F-030: Lotes sin cargar el histórico entero. Los números tienen que seguir
// cuadrando con la cola de revisión (reviewQueue) y con «Rechazar lote».
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { batchWindowWhere, groupBatches, loadBatchRows } from "@/lib/batchGroups";
import { getQueuePosition, QUEUE_ORDER } from "@/lib/reviewQueue";
import { BATCH_REJECT_EXCLUDED_STATUSES } from "@/lib/invoiceStatuses";

let w: FirmWorld;
// makeFirm ya deja dos facturas (septiembre de 2026): fuera de estas cuentas.
let mine: { clientId: string; NOT: { id: { in: string[] } } };
beforeEach(async () => {
  w = await makeFirm("A");
  mine = { clientId: w.client.id, NOT: { id: { in: [w.invoices.pending.id, w.invoices.validated.id] } } };
});

const clients = () => new Map([[w.client.id, { name: w.client.name, cif: w.client.cif }]]);
let n = 0;
const inv = (status: string, extra: Record<string, unknown> = {}) =>
  makeInvoice(w.client, { status: status as never, totalAmount: 100 + ++n, periodMonth: 4, periodYear: 2026, ...extra });

describe("paridad de Lotes con la cola y con «Rechazar lote» (F-030)", () => {
  it("incidencias, listas, primera pendiente y rechazables cuadran", async () => {
    await inv("NEEDS_ATTENTION");
    await inv("OCR_ERROR");
    const conIncidencia = await inv("PENDING_REVIEW");
    await prisma.invoiceIssue.create({ data: { invoiceId: conIncidencia.id, type: "MANUAL", description: "x" } });
    const cerrada = await inv("PENDING_REVIEW");
    await prisma.invoiceIssue.create({ data: { invoiceId: cerrada.id, type: "MANUAL", description: "y", status: "RESOLVED" } });
    await inv("PENDING_REVIEW", { deferredAt: new Date() });
    await inv("PENDING_REVIEW");
    await inv("VALIDATED");
    const exportada = await inv("VALIDATED");
    const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: exportada.id, snapshot: "{}" } });
    await inv("REJECTED");
    await inv("UPLOADED");
    await inv("SPLIT_SOURCE");
    // Otro lote: ventas del mismo mes.
    await inv("PENDING_REVIEW", { type: "SALE" });

    const groups = groupBatches(await loadBatchRows(mine), clients());
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      const filter = { clientId: g.clientId, periodMonth: g.periodMonth, periodYear: g.periodYear, type: g.type };
      const anyId = g.firstPendingId!;
      const attention = await getQueuePosition(anyId, { ...filter, bucket: "attention" });
      const clean = await getQueuePosition(anyId, { ...filter, bucket: "clean" });
      expect([g.attentionCount, g.cleanCount]).toEqual([attention.pendingInBucket, clean.pendingInBucket]);
      // La primera pendiente es la primera de la cola.
      const first = await prisma.invoice.findFirst({
        where: { ...filter, status: { in: ["PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR"] } },
        orderBy: QUEUE_ORDER,
      });
      expect(g.firstPendingId).toBe(first!.id);
      // Lo que tocaría «Rechazar lote» (el mismo where que la acción).
      const rejectable = await prisma.invoice.count({
        where: { ...filter, periodType: g.periodType, exportBatchItems: { none: {} }, status: { notIn: BATCH_REJECT_EXCLUDED_STATUSES } },
      });
      expect(g.rejectable).toBe(rejectable);
    }
    const compras = groups.find((g) => g.type === "PURCHASE")!;
    expect(compras).toMatchObject({ attentionCount: 3, cleanCount: 3, validated: 1, exported: 1, rejected: 1, processingCount: 1, total: 10 });
  });
});

describe("ventana por defecto (F-030)", () => {
  const now = new Date("2026-09-15T10:00:00Z");

  it("los últimos 12 meses, y de antes solo los lotes con algo pendiente, enteros", async () => {
    await inv("VALIDATED", { periodMonth: 10, periodYear: 2025 }); // dentro (octubre de 2025)
    await inv("VALIDATED", { periodMonth: 9, periodYear: 2025 }); // fuera y terminado
    await inv("VALIDATED", { periodMonth: 3, periodYear: 2024 });
    await inv("PENDING_REVIEW", { periodMonth: 3, periodYear: 2024 }); // lote viejo con algo pendiente
    const rows = await loadBatchRows(await batchWindowWhere(mine, now));
    const periods = rows.map((r) => `${r.periodYear}-${r.periodMonth}`).sort();
    expect(periods).toEqual(["2024-3", "2024-3", "2025-10"]);
  });

  it("sin ventana (año elegido o histórico), todo", async () => {
    await inv("VALIDATED", { periodMonth: 9, periodYear: 2025 });
    expect(await loadBatchRows(mine)).toHaveLength(1);
  });

  it("la ventana no saca facturas de otra asesoría", async () => {
    const b = await makeFirm("B");
    await makeInvoice(b.client, { status: "PENDING_REVIEW", periodMonth: 3, periodYear: 2024 });
    const rows = await loadBatchRows(await batchWindowWhere({ client: { advisoryFirmId: w.firm.id } }, now));
    // Solo las dos de A que deja makeFirm; la vieja pendiente de B no entra.
    expect(rows.map((r) => r.id).sort()).toEqual([w.invoices.pending.id, w.invoices.validated.id].sort());
  });
});
