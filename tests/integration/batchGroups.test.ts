// F-030: Lotes sin cargar el histórico entero. Los números tienen que seguir
// cuadrando con la cola de revisión (reviewQueue) y con «Rechazar lote».
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { batchWindowWhere, groupBatches, loadBatchRows, MAX_RESCUED_PERIODS } from "@/lib/batchGroups";
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

  const close = (clientId: string, month: number, year: number) =>
    prisma.periodClosure.create({ data: { clientId, month, year, closedBy: w.admin.id } });
  const exportedBatch = async (invoiceId: string, keepPointer = true) => {
    const batch = await prisma.exportBatch.create({ data: { format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId, snapshot: "{}" } });
    if (keepPointer) await prisma.invoice.update({ where: { id: invoiceId }, data: { exportBatchId: batch.id } });
  };
  const periods = async (where: object) =>
    (await loadBatchRows(await batchWindowWhere(where, now))).map((r) => `${r.periodYear}-${r.periodMonth}`).sort();

  it("los últimos 12 meses, y de antes lo que pide algo; lo cerrado y exportado, fuera", async () => {
    await inv("VALIDATED", { periodMonth: 10, periodYear: 2025 }); // dentro (octubre de 2025)
    // Cerrado y exportado: lo único que se queda fuera.
    const done = await inv("VALIDATED", { periodMonth: 9, periodYear: 2025 });
    await exportedBatch(done.id);
    await close(w.client.id, 9, 2025);
    // Algo pendiente de revisar.
    await inv("PENDING_REVIEW", { periodMonth: 3, periodYear: 2024 });
    // Todo validado y sin exportar.
    await inv("VALIDATED", { periodMonth: 4, periodYear: 2024 });
    // Cerrado, con una reexportada (corregida después de exportarse).
    const re = await inv("VALIDATED", { periodMonth: 5, periodYear: 2024 });
    await exportedBatch(re.id, false);
    await close(w.client.id, 5, 2024);
    // Cerrado, con una validada sin cuenta (bloqueante): sigue sin lote.
    await inv("VALIDATED", { periodMonth: 6, periodYear: 2024, supplierAccount: null });
    await close(w.client.id, 6, 2024);
    // Exportado pero sin cerrar: «por cerrar».
    const unclosed = await inv("VALIDATED", { periodMonth: 7, periodYear: 2024 });
    await exportedBatch(unclosed.id);
    expect(await periods(mine)).toEqual(["2024-3", "2024-4", "2024-5", "2024-6", "2024-7", "2025-10"]);
  });

  it("el periodo de otro cliente, validado y sin exportar, también", async () => {
    const other = await prisma.client.create({ data: { name: "Otro SL", cif: "B99999999", advisoryFirmId: w.firm.id } });
    await makeInvoice(other, { status: "VALIDATED", periodMonth: 2, periodYear: 2024 });
    expect(await periods({ clientId: other.id })).toEqual(["2024-2"]);
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

  // Revisión 2, punto 1: una asesoría que no cierra periodos rescata casi
  // todo. Miles de periodos sueltos en el OR eran más lentos que sin ventana.
  describe("una asesoría que no cierra periodos", () => {
    let seq = 0;
    // Clientes con 20 meses viejos (2023-2024) rechazados y sin cerrar: solo
    // los rescata «sin cierre activo». Con `closedOne`, además un mes cerrado
    // (escondido), así que el cliente no se rescata entero.
    const clientsWithOldPeriods = async (count: number, closedOne: boolean) => {
      const ids: string[] = [];
      for (let c = 0; c < count; c++) {
        const client = await prisma.client.create({
          data: { name: `Cliente ${++seq}`, cif: `Z${Date.now()}${seq}`, advisoryFirmId: w.firm.id },
        });
        ids.push(client.id);
        const months = Array.from({ length: 20 }, (_, i) => ({ periodYear: 2023 + Math.floor(i / 12), periodMonth: (i % 12) + 1 }));
        if (closedOne) months.push({ periodYear: 2022, periodMonth: 1 });
        await prisma.invoice.createMany({
          data: months.map((m) => ({
            ...m,
            clientId: client.id,
            filename: `v${++seq}.pdf`,
            storageKey: `${client.id}/v${seq}.pdf`,
            fileType: "application/pdf",
            type: "PURCHASE" as const,
            status: "REJECTED" as const,
            invoiceNumber: `V-${seq}`,
          })),
        });
        if (closedOne) await close(client.id, 1, 2022);
      }
      return ids;
    };
    const ids = async (where: object) => (await loadBatchRows(where)).map((r) => r.id).sort();

    it("un cliente con todos sus periodos viejos rescatados va entero; lo cerrado sigue fuera", async () => {
      const whole = await clientsWithOldPeriods(120, false); // 2.400 periodos: por encima del tope si fueran sueltos
      const hidden = await clientsWithOldPeriods(1, true);
      const scope = { clientId: { in: [...whole, ...hidden] } };
      const windowed = await ids(await batchWindowWhere(scope, now));
      const all = await ids(scope);
      // Todo menos el mes cerrado del último cliente.
      expect(windowed).toHaveLength(all.length - 1);
      const closedRow = await prisma.invoice.findFirst({ where: { clientId: hidden[0], periodYear: 2022 } });
      expect(windowed).not.toContain(closedRow!.id);
    }, 60_000);

    it("por encima del tope de periodos sueltos, sin ventana: lo mismo que «ver todo el histórico»", async () => {
      const partial = await clientsWithOldPeriods(Math.ceil(MAX_RESCUED_PERIODS / 20) + 5, true);
      const scope = { clientId: { in: partial } };
      const where = await batchWindowWhere(scope, now);
      expect(where).toBe(scope);
      expect(await ids(where)).toEqual(await ids(scope));
    }, 60_000);
  });
});
