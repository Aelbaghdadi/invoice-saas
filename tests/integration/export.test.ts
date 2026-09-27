// Export a A3 (PR #3, F-001/F-049; PR #4, originales divididas): reserva
// transaccional, exports simultaneos, correccion cruzada y aislamiento.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { wait } from "./helpers/fixtures";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { commitExportBatch, ExportConflictError, type ExportInvoice } from "@/lib/exportBatch";
import { appendAuditLogs, verifyFirmAuditChains } from "@/lib/auditLog";
import { partitionA3Exportable } from "@/lib/exportFormats";
import { exportInvoiceWhere } from "@/lib/exportRequest";
import { GET as exportPreview, POST as exportDownload } from "@/app/api/export/route";
import { validateInvoice } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
const request = { periodType: "MONTHLY" as const, month: 4, year: 2026, type: "ALL" as const, format: "a3excel" as const };

beforeEach(async () => {
  w = await makeFirm("A");
});

/** n facturas VALIDATED de abril, con historia de auditoria previa. */
async function seedValidated(n: number, opts: { zeroTotals?: number } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    filename: `f${i}.pdf`, storageKey: `k${i}`, fileType: "application/pdf", type: "PURCHASE" as const,
    periodMonth: 4, periodYear: 2026, clientId: w.client.id, status: "VALIDATED" as const,
    invoiceNumber: `F-${i}`, invoiceDate: new Date("2026-04-15"), issuerName: "Prov", issuerCif: "B12345674",
    taxBase: 100, vatRate: 21, vatAmount: 21, totalAmount: i < (opts.zeroTotals ?? 0) ? 0 : 121,
  }));
  for (let i = 0; i < rows.length; i += 1000) await prisma.invoice.createMany({ data: rows.slice(i, i + 1000) });
  const invoices = await prisma.invoice.findMany({ where: { clientId: w.client.id, periodMonth: 4 }, select: { id: true } });
  // Cadena de auditoria previa: tres eslabones por factura.
  await appendAuditLogs(invoices.flatMap((inv) => [
    { invoiceId: inv.id, userId: w.worker.id, field: "status", oldValue: "PENDING_REVIEW", newValue: "VALIDATED" },
    { invoiceId: inv.id, userId: w.worker.id, field: "invoiceNumber", oldValue: null, newValue: "x" },
    { invoiceId: inv.id, userId: w.worker.id, field: "totalAmount", oldValue: null, newValue: "121" },
  ]));
}

function readCandidates(): Promise<ExportInvoice[]> {
  return prisma.invoice.findMany({
    where: exportInvoiceWhere({ ...request, clientId: w.client.id }, w.firm.id),
    include: { client: true, vatLines: { orderBy: { position: "asc" } } },
    orderBy: [{ invoiceDate: "asc" }],
  }) as Promise<ExportInvoice[]>;
}

const batchData = (id: string, userId = w.admin.id) => ({
  id, format: "a3excel", clientId: w.client.id, periodType: "MONTHLY" as const, periodMonth: 4, periodYear: 2026, invoiceType: "ALL", userId,
});

function downloadRequest(clientId = w.client.id) {
  return new NextRequest("http://app.local/api/export", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
    body: JSON.stringify({ ...request, clientId }),
  });
}

describe("commitExportBatch contra Postgres real", () => {
  it("camino feliz: lote, items, puntero y auditoría; cadenas intactas", async () => {
    await seedValidated(50, { zeroTotals: 3 });
    const { exportable, excluded } = partitionA3Exportable(await readCandidates());
    expect(excluded).toHaveLength(3);
    await commitExportBatch(batchData("batch-ok"), exportable);
    expect(await prisma.invoice.count({ where: { exportBatchId: "batch-ok" } })).toBe(47);
    expect(await prisma.exportBatchItem.count({ where: { exportBatchId: "batch-ok" } })).toBe(47);
    expect((await prisma.exportBatch.findUniqueOrThrow({ where: { id: "batch-ok" } })).invoiceCount).toBe(47);
    expect(await prisma.auditLog.count({ where: { field: "export" } })).toBe(47);
    expect((await verifyFirmAuditChains(w.firm.id)).brokenChains).toBe(0);
  });

  it("un fallo en la auditoría deshace todo: ni lote ni facturas marcadas", async () => {
    await seedValidated(20);
    // userId inexistente: la FK de AuditLog.userId falla al final de la transaccion.
    await expect(commitExportBatch(batchData("batch-fail", "no-existe"), await readCandidates())).rejects.toThrow();
    expect(await prisma.invoice.count({ where: { exportBatchId: { not: null } } })).toBe(0);
    expect(await prisma.exportBatch.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { field: "export" } })).toBe(0);
  });

  it("dos exportaciones a la vez: solo una marca, la otra da conflicto sin escribir nada", async () => {
    await seedValidated(300);
    const [a, b] = [await readCandidates(), await readCandidates()];
    const results = await Promise.allSettled([
      commitExportBatch(batchData("batch-a"), a),
      commitExportBatch(batchData("batch-b"), b),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ko = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ko).toHaveLength(1);
    expect(ko[0].reason).toBeInstanceOf(ExportConflictError);
    expect(await prisma.exportBatch.count()).toBe(1);
    const items = await prisma.exportBatchItem.groupBy({ by: ["invoiceId"], _count: true });
    expect(items).toHaveLength(300);
    expect(items.every((i) => i._count === 1)).toBe(true);
    expect((await verifyFirmAuditChains(w.firm.id)).brokenChains).toBe(0);
  });

  it("una corrección entre la lectura y la reserva aborta la exportación", async () => {
    await seedValidated(10);
    const invoices = await readCandidates();
    await prisma.invoice.update({ where: { id: invoices[4].id }, data: { invoiceNumber: "F-CORREGIDA" } });
    const err = await commitExportBatch(batchData("batch-stale"), invoices).catch((e) => e);
    expect(err).toBeInstanceOf(ExportConflictError);
    expect(err.invoiceIds).toEqual([invoices[4].id]);
    expect(await prisma.exportBatch.count()).toBe(0);
  });

  it("3.000 facturas en un lote, dentro del timeout", async () => {
    await seedValidated(3000);
    const t0 = performance.now();
    await commitExportBatch(batchData("batch-big"), await readCandidates());
    expect(performance.now() - t0).toBeLessThan(30_000);
    expect(await prisma.invoice.count({ where: { exportBatchId: "batch-big" } })).toBe(3000);
    expect((await verifyFirmAuditChains(w.firm.id)).brokenChains).toBe(0);
  });
});

describe("corrección cruzada con un export (F-049)", () => {
  it("con el export reservando, la corrección del gestor no se cuela: el Excel y la fila coinciden", async () => {
    const inv = await makeInvoice(w.client, {
      status: "VALIDATED", periodMonth: 4, invoiceNumber: "F-001", invoiceDate: new Date("2026-04-10"),
      receiverName: w.client.name, receiverCif: w.client.cif, supplierAccount: "40000001", expenseAccount: "60000001",
    });
    await prisma.invoiceVatLine.create({ data: { invoiceId: inv.id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
    const leido = inv.updatedAt;
    // El export se para despues de reservar las facturas (antes de crear los items).
    const lock = await holdLock('LOCK TABLE "ExportBatchItem" IN SHARE MODE');
    signInAs(w.admin);
    const exporting = exportDownload(downloadRequest());
    await wait(1500);
    expect(await sessionsWaitingForLock()).toBeGreaterThan(0);
    // El gestor guarda una correccion con lo que leyo antes del export.
    signInAs(w.worker);
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      invoiceId: inv.id, updatedAt: leido.toISOString(), type: "PURCHASE",
      issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: w.client.name, receiverCif: w.client.cif,
      invoiceNumber: "F-CORREGIDA", invoiceDate: "2026-04-10", totalAmount: "121",
      vatLines: JSON.stringify([{ taxBase: "100", vatRate: "21", vatAmount: "21" }]),
      supplierAccount: "40000001", expenseAccount: "60000001", operationType: "INTERIOR",
      accountingPeriodMonth: "4", accountingPeriodYear: "2026",
    })) fd.set(k, v);
    const correcting = validateInvoice(null, fd).catch((e) => (e?.message === "NEXT_REDIRECT" ? null : Promise.reject(e)));
    await wait(1500);
    await lock.release();
    const res = await exporting;
    const corrected = await correcting;
    expect(res.status).toBe(200);
    expect(corrected?.error).toBeTruthy();
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    const item = await prisma.exportBatchItem.findFirstOrThrow({ where: { invoiceId: inv.id } });
    expect(row.invoiceNumber).toBe("F-001");
    expect(JSON.parse(item.snapshot).invoiceNumber).toBe(row.invoiceNumber);
  });
});

describe("originales divididas en el export (PR #4)", () => {
  it("la original VALIDATED con hijas se queda fuera y se cuenta aparte", async () => {
    const base = { status: "VALIDATED" as const, periodMonth: 4, invoiceDate: new Date("2026-04-15") };
    const orig = await makeInvoice(w.client, { ...base, invoiceNumber: "ORIG" });
    await makeInvoice(w.client, { ...base, invoiceNumber: "H1", splitFromId: orig.id });
    await makeInvoice(w.client, { ...base, invoiceNumber: "H2", splitFromId: orig.id });
    await makeInvoice(w.client, { ...base, invoiceNumber: "Z", totalAmount: 0 });
    signInAs(w.admin);
    const preview = await exportPreview(new NextRequest(
      `http://app.local/api/export?clientId=${w.client.id}&periodType=MONTHLY&month=4&year=2026&preview=1`,
    ));
    const body = await preview.json();
    expect(body.count).toBe(2);
    expect(body.excludedByReason).toEqual({ total_cero: 1, dividida: 1 });
    const download = await exportDownload(downloadRequest());
    expect(download.status).toBe(200);
    expect(JSON.parse(download.headers.get("X-Export-Excluded-Detail")!)).toEqual({ total_cero: 1, dividida: 1 });
    const marked = await prisma.invoice.findMany({ where: { exportBatchId: { not: null } }, select: { invoiceNumber: true } });
    expect(marked.map((i) => i.invoiceNumber).sort()).toEqual(["H1", "H2"]);
  });
});

describe("aislamiento entre asesorías", () => {
  it("el admin de B no ve ni exporta las facturas del cliente de A", async () => {
    await seedValidated(3);
    const b = await makeFirm("B");
    signInAs(b.admin);
    const preview = await exportPreview(new NextRequest(
      `http://app.local/api/export?clientId=${w.client.id}&periodType=MONTHLY&month=4&year=2026&preview=1`,
    ));
    expect((await preview.json()).count ?? 0).toBe(0);
    const download = await exportDownload(downloadRequest(w.client.id));
    expect(download.status).not.toBe(200);
    expect(await prisma.invoice.count({ where: { exportBatchId: { not: null } } })).toBe(0);
    expect(await prisma.exportBatch.count()).toBe(0);
  });
});
