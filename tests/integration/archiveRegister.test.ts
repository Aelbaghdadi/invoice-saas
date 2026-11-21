// Nº de registro del archivo al exportar a A3 (paso 3, R6-R8; anexo C5, C9 y
// C11): por la ruta de exportación de verdad, con partitionA3Exportable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Invoice } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { POST as exportDownload } from "@/app/api/export/route";
import { commitExportBatch, EXPORT_WAITS, ExportConflictError, type ExportInvoice } from "@/lib/exportBatch";
import { appendAuditLogs, verifyFirmAuditChains } from "@/lib/auditLog";
import { exportInvoiceWhere } from "@/lib/exportRequest";
import { partitionA3Exportable } from "@/lib/exportFormats";
import { flagLateRegistrations } from "@/lib/archiveRules";
import { formatRegisterNumber } from "@/lib/registerNumbers";
import { rejectBatch } from "@/app/dashboard/worker/batch/actions";

let w: FirmWorld;
const LOCK_TIMEOUT_MS = EXPORT_WAITS.lockTimeoutMs;

beforeEach(async () => {
  w = await makeFirm("A");
  signInAs(w.admin);
});
afterEach(() => {
  EXPORT_WAITS.lockTimeoutMs = LOCK_TIMEOUT_MS;
});

type Seed = {
  month: number;
  number: string;
  type?: "PURCHASE" | "SALE";
  date?: string;
  total?: number;
  accounting?: { month: number; year: number };
  receivedAt?: string;
  position?: { batchId: string; position: number };
  splitFromId?: string;
  splitPart?: number;
};

/** Una factura VALIDATED de 2026, con su línea de IVA (como las deja la revisión). */
async function validated(seed: Seed): Promise<Invoice> {
  const sale = seed.type === "SALE";
  const invoice = await makeInvoice(w.client, {
    status: "VALIDATED",
    type: seed.type ?? "PURCHASE",
    periodMonth: seed.month,
    periodYear: 2026,
    accountingPeriodMonth: seed.accounting?.month ?? null,
    accountingPeriodYear: seed.accounting?.year ?? null,
    invoiceNumber: seed.number,
    invoiceDate: new Date(seed.date ?? `2026-${String(seed.month).padStart(2, "0")}-15`),
    totalAmount: seed.total ?? 121,
    splitFromId: seed.splitFromId ?? null,
    ...(sale
      ? { issuerName: w.client.name, issuerCif: w.client.cif, receiverName: "Cliente final SL", receiverCif: "B12345674", supplierAccount: "43000001", expenseAccount: "70000001" }
      : { receiverName: w.client.name, receiverCif: w.client.cif }),
  });
  await prisma.invoiceVatLine.create({ data: { invoiceId: invoice.id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
  if (seed.receivedAt || seed.position || seed.splitPart) {
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: {
        ...(seed.receivedAt ? { receivedAt: new Date(seed.receivedAt) } : {}),
        ...(seed.position ? { uploadBatchId: seed.position.batchId, uploadPosition: seed.position.position } : {}),
        ...(seed.splitPart ? { splitPart: seed.splitPart } : {}),
      },
    });
  }
  return invoice;
}

function exportPeriod(month: number, confirmedReexports?: string[]) {
  return exportDownload(new NextRequest("http://app.local/api/export", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "app.local" },
    body: JSON.stringify({
      periodType: "MONTHLY", month, year: 2026, type: "ALL", format: "a3excel", clientId: w.client.id,
      ...(confirmedReexports ? { confirmedReexports } : {}),
    }),
  }));
}

async function readCandidates(month: number): Promise<ExportInvoice[]> {
  const rows = await prisma.invoice.findMany({
    where: exportInvoiceWhere({ periodType: "MONTHLY", month, year: 2026, type: "ALL", clientId: w.client.id }, w.firm.id),
    include: { client: true, vatLines: { orderBy: { position: "asc" } } },
  }) as ExportInvoice[];
  return partitionA3Exportable(rows).exportable;
}

const batchData = (id: string, month: number, userId = w.admin.id) => ({
  id, format: "a3excel", clientId: w.client.id, periodType: "MONTHLY" as const, periodMonth: month, periodYear: 2026, invoiceType: "ALL", userId,
});

/** Nº de factura → nº de registro, de las del cliente que ya lo tienen. */
async function registers(): Promise<Record<string, string>> {
  const rows = await prisma.invoiceArchive.findMany({
    where: { invoice: { clientId: w.client.id }, registerNumber: { not: null } },
    select: { registerNumber: true, registerSeries: { select: { type: true, year: true } }, invoice: { select: { invoiceNumber: true } } },
    orderBy: [{ registerSeriesId: "asc" }, { registerNumber: "asc" }],
  });
  return Object.fromEntries(rows.map((r) => [r.invoice.invoiceNumber, formatRegisterNumber(r.registerSeries!, r.registerNumber!)]));
}

async function counters() {
  return (await prisma.invoiceRegisterSeries.findMany({ where: { clientId: w.client.id }, orderBy: [{ type: "asc" }, { year: "asc" }] }))
    .map((s) => `${s.type} ${s.year}: ${s.lastNumber}`);
}

describe("nº de registro al exportar (R6, R7)", () => {
  it("numera R-2026/0001 y siguientes en orden de llegada y de posición en la tanda; el siguiente periodo sigue", async () => {
    const batch = await prisma.uploadBatch.create({
      data: { advisoryFirmId: w.firm.id, clientId: w.client.id, createdById: w.worker.id, fileCount: 2, periodType: "MONTHLY", periodMonth: 4, periodYear: 2026, invoiceType: "PURCHASE" },
    });
    // Dadas de alta en otro orden que el de llegada.
    await validated({ month: 4, number: "A-TARDE", receivedAt: "2026-04-20T11:00:00Z" });
    await validated({ month: 4, number: "A-POS2", receivedAt: "2026-04-20T10:00:00Z", position: { batchId: batch.id, position: 2 } });
    await validated({ month: 4, number: "A-POS1", receivedAt: "2026-04-20T10:00:00Z", position: { batchId: batch.id, position: 1 } });
    await validated({ month: 4, number: "A-PRIMERA", receivedAt: "2026-04-20T09:00:00Z" });
    expect((await exportPeriod(4)).status).toBe(200);
    expect(await registers()).toEqual({
      "A-PRIMERA": "R-2026/0001", "A-POS1": "R-2026/0002", "A-POS2": "R-2026/0003", "A-TARDE": "R-2026/0004",
    });

    await validated({ month: 5, number: "M-1" });
    expect((await exportPeriod(5)).status).toBe(200);
    expect((await registers())["M-1"]).toBe("R-2026/0005");
    expect(await counters()).toEqual(["PURCHASE 2026: 5"]);

    // registeredAt es la fecha del lote en el que salió.
    const rows = await prisma.invoiceArchive.findMany({
      where: { registerNumber: { not: null }, invoice: { clientId: w.client.id } },
      select: { registeredAt: true, invoice: { select: { exportBatch: { select: { createdAt: true } } } } },
    });
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.registeredAt).toEqual(row.invoice.exportBatch!.createdAt);
  });

  it("las emitidas van a la serie E, por fecha y nº de factura en orden natural", async () => {
    await validated({ month: 4, type: "SALE", number: "F-10", date: "2026-04-10" });
    await validated({ month: 4, type: "SALE", number: "F-2", date: "2026-04-10" });
    await validated({ month: 4, type: "SALE", number: "F-30", date: "2026-04-05" });
    await validated({ month: 4, number: "COMPRA-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    expect(await registers()).toEqual({
      "COMPRA-1": "R-2026/0001", "F-30": "E-2026/0001", "F-2": "E-2026/0002", "F-10": "E-2026/0003",
    });
    expect(await counters()).toEqual(["PURCHASE 2026: 1", "SALE 2026: 3"]);
  });

  it("dos años de deducción en el mismo lote van a dos series", async () => {
    await validated({ month: 1, number: "DIC-25", accounting: { month: 12, year: 2025 }, date: "2025-12-20" });
    await validated({ month: 1, number: "ENE-26", date: "2026-01-10" });
    expect((await exportPeriod(1)).status).toBe(200);
    expect(await registers()).toEqual({ "DIC-25": "R-2025/0001", "ENE-26": "R-2026/0001" });
    expect(await counters()).toEqual(["PURCHASE 2025: 1", "PURCHASE 2026: 1"]);
  });

  it("reexportar una factura corregida conserva su número y no gasta otro", async () => {
    const first = await validated({ month: 4, number: "F-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    // La corrección tras exportar la devuelve a la cola (exportBatchId a null).
    await prisma.invoice.update({ where: { id: first.id }, data: { invoiceNumber: "F-1B", exportBatchId: null } });
    await validated({ month: 4, number: "F-2" });
    expect((await exportPeriod(4, [first.id])).status).toBe(200);
    expect(await registers()).toEqual({ "F-1B": "R-2026/0001", "F-2": "R-2026/0002" });
    expect(await counters()).toEqual(["PURCHASE 2026: 2"]);
    expect(await prisma.auditLog.count({ where: { invoiceId: first.id, field: "registerNumber" } })).toBe(1);
  });

  it("las de total 0 y las originales divididas no llevan número; sus partes sí", async () => {
    const original = await validated({ month: 4, number: "ORIG", receivedAt: "2026-04-03T08:00:00Z" });
    await validated({ month: 4, number: "H2", splitFromId: original.id, receivedAt: "2026-04-03T08:00:00Z", splitPart: 2 });
    await validated({ month: 4, number: "H1", splitFromId: original.id, receivedAt: "2026-04-03T08:00:00Z", splitPart: 1 });
    await validated({ month: 4, number: "CERO", total: 0 });
    const res = await exportPeriod(4);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Excluded")).toBe("2");
    expect(await registers()).toEqual({ H1: "R-2026/0001", H2: "R-2026/0002" });
  });

  it("primera exportación de un cliente sin series: crea la serie, con las fechas en UTC (anexo C9)", async () => {
    await validated({ month: 4, number: "F-1" });
    expect(await prisma.invoiceRegisterSeries.count()).toBe(0);
    expect((await exportPeriod(4)).status).toBe(200);
    const [series] = await prisma.invoiceRegisterSeries.findMany();
    expect(series).toMatchObject({ clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 1 });
    // El Postgres de pruebas va en hora de París: con now() a secas saldría una
    // hora desplazada.
    expect(Math.abs(series.updatedAt.getTime() - Date.now())).toBeLessThan(10 * 60_000);
    const row = await prisma.invoiceArchive.findFirstOrThrow({ where: { registerSeriesId: series.id } });
    expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(10 * 60_000);
    expect(row.registeredAt).toEqual((await prisma.exportBatch.findFirstOrThrow()).createdAt);
  });

  it("una factura sin fila de archivo (los triggers quitados) se numera igual: la fila se crea al exportar (anexo C5)", async () => {
    const invoice = await prisma.$transaction(async (tx) => {
      // Sin triggers en esta transacción: como si invoice_archive_row no existiera.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      return tx.invoice.create({
        data: {
          filename: "sin-fila.pdf", storageKey: `${w.client.id}/2026-04/sin-fila.pdf`, fileType: "application/pdf",
          type: "PURCHASE", periodMonth: 4, periodYear: 2026, clientId: w.client.id, status: "VALIDATED",
          invoiceNumber: "SIN-FILA", invoiceDate: new Date("2026-04-15"), issuerName: "Proveedor SL", issuerCif: "B12345674",
          receiverName: w.client.name, receiverCif: w.client.cif, taxBase: 100, vatRate: 21, vatAmount: 21, totalAmount: 121,
          supplierAccount: "40000001", expenseAccount: "60000001",
        },
      });
    });
    await prisma.invoiceVatLine.create({ data: { invoiceId: invoice.id, position: 0, taxBase: 100, vatRate: 21, vatAmount: 21 } });
    expect(await prisma.invoiceArchive.count({ where: { invoiceId: invoice.id } })).toBe(0);

    expect((await exportPeriod(4)).status).toBe(200);
    const row = await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: invoice.id } });
    expect(row.registerNumber).toBe(1);
    expect(row.receivedAt).toEqual(invoice.createdAt);
  });
});

describe("el nº de registro no se gasta si la exportación no se confirma", () => {
  it("un ExportConflictError (una corrección cruzada) no gasta números ni mueve el contador", async () => {
    await validated({ month: 4, number: "F-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    const crossed = await validated({ month: 4, number: "F-2" });
    const candidates = await readCandidates(4);
    await prisma.invoice.update({ where: { id: crossed.id }, data: { invoiceNumber: "F-2-CORREGIDA" } });
    const err = await commitExportBatch(batchData("lote-cruzado", 4), candidates).catch((e) => e);
    expect(err).toBeInstanceOf(ExportConflictError);
    expect(await counters()).toEqual(["PURCHASE 2026: 1"]);
    expect(await registers()).toEqual({ "F-1": "R-2026/0001" });
    // Lo que se exporta después sigue sin huecos.
    expect((await exportPeriod(4)).status).toBe(200);
    expect(await registers()).toEqual({ "F-1": "R-2026/0001", "F-2-CORREGIDA": "R-2026/0002" });
  });

  it("un fallo después de numerar (la auditoría) lo deshace todo: ni números ni serie", async () => {
    await validated({ month: 4, number: "F-1" });
    // userId inexistente: la FK de AuditLog falla al final, ya numeradas.
    const err = await commitExportBatch(batchData("lote-roto", 4, "no-existe"), await readCandidates(4)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExportConflictError);
    expect(await prisma.invoiceRegisterSeries.count()).toBe(0);
    expect(await registers()).toEqual({});
    expect((await exportPeriod(4)).status).toBe(200);
    expect(await registers()).toEqual({ "F-1": "R-2026/0001" });
  });

  it("si otra transacción retiene la serie más del lock_timeout: 409 ERR-EXPORT-003 y nada escrito (anexo C11)", async () => {
    await validated({ month: 4, number: "F-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    const may = await validated({ month: 5, number: "M-1" });
    EXPORT_WAITS.lockTimeoutMs = 300;
    const lock = await holdLock(`SELECT 1 FROM "InvoiceRegisterSeries" WHERE "clientId" = $1 FOR UPDATE`, w.client.id);
    try {
      const res = await exportPeriod(5);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatchObject({ code: "ERR-EXPORT-003" });
    } finally {
      await lock.release();
    }
    expect(await prisma.exportBatch.count()).toBe(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: may.id } })).exportBatchId).toBeNull();
    expect(await counters()).toEqual(["PURCHASE 2026: 1"]);
    // Suelto el bloqueo, sale con el siguiente número.
    expect((await exportPeriod(5)).status).toBe(200);
    expect((await registers())["M-1"]).toBe("R-2026/0002");
  });
});

describe("dos exportaciones de la misma serie a la vez", () => {
  it("esperan en la fila de la serie y no repiten ni se saltan números", async () => {
    await validated({ month: 4, number: "A-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    for (const n of [1, 2, 3]) await validated({ month: 5, number: `M-${n}` });
    for (const n of [1, 2]) await validated({ month: 6, number: `J-${n}` });
    // Con la fila de la serie retenida, las dos llegan a la reserva y esperan.
    // Leer el último número y sumar (sin ON CONFLICT ni bloqueo) les daría a
    // las dos los mismos.
    const lock = await holdLock(`SELECT 1 FROM "InvoiceRegisterSeries" WHERE "clientId" = $1 FOR UPDATE`, w.client.id);
    const may = inFlight(exportPeriod(5));
    const june = inFlight(exportPeriod(6));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(2), { timeout: 10_000 });
    await lock.release();
    expect((await may).status).toBe(200);
    expect((await june).status).toBe(200);

    const numbers = Object.values(await registers()).map((r) => Number(r.slice(-4))).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await counters()).toEqual(["PURCHASE 2026: 6"]);
    // Cada lote se lleva un bloque seguido.
    const registered = await registers();
    const block = (prefix: string) => Object.entries(registered).filter(([n]) => n.startsWith(prefix)).map(([, r]) => Number(r.slice(-4))).sort((a, b) => a - b);
    const mayBlock = block("M-");
    const juneBlock = block("J-");
    expect(mayBlock[mayBlock.length - 1] - mayBlock[0]).toBe(2);
    expect(juneBlock[juneBlock.length - 1] - juneBlock[0]).toBe(1);
  });
});

describe("«Rechazar lote» cruzado con una exportación", () => {
  it("la factura que el export ya ha reservado sale en el Excel con su número y no queda rechazada", async () => {
    await validated({ month: 3, number: "A-1" });
    expect((await exportPeriod(3)).status).toBe(200);
    const april = await validated({ month: 4, number: "F-1" });
    // El export reserva la factura y se para en la serie; el rechazo del lote
    // la lee como no exportada y espera a su fila.
    const lock = await holdLock(`SELECT 1 FROM "InvoiceRegisterSeries" WHERE "clientId" = $1 FOR UPDATE`, w.client.id);
    const exporting = inFlight(exportPeriod(4));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    const form = new FormData();
    for (const [key, value] of Object.entries({ clientId: w.client.id, month: "4", year: "2026", type: "PURCHASE", periodType: "MONTHLY", reason: "Lote subido por error" })) {
      form.set(key, value);
    }
    const rejecting = inFlight(rejectBatch(null, form));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(2), { timeout: 10_000 });
    await lock.release();

    expect((await exporting).status).toBe(200);
    expect(await rejecting).toEqual({ error: "No hay facturas en este lote que se puedan rechazar (ya exportadas, rechazadas o en análisis)" });
    const after = await prisma.invoice.findUniqueOrThrow({
      where: { id: april.id },
      select: { status: true, exportBatchId: true, _count: { select: { exportBatchItems: true } } },
    });
    expect(after.status).toBe("VALIDATED");
    expect(after.exportBatchId).not.toBeNull();
    expect(after._count.exportBatchItems).toBe(1);
    expect((await registers())["F-1"]).toBe("R-2026/0002");
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: april.id, toStatus: "REJECTED" } })).toBe(0);
  });
});

describe("auditoría y avisos", () => {
  it("la entrada registerNumber va con la del export, en la misma transacción, y las cadenas quedan íntegras", async () => {
    const invoice = await validated({ month: 4, number: "F-1" });
    await appendAuditLogs([{ invoiceId: invoice.id, userId: w.worker.id, field: "status", oldValue: "PENDING_REVIEW", newValue: "VALIDATED" }]);
    expect((await exportPeriod(4)).status).toBe(200);
    const entries = await prisma.auditLog.findMany({ where: { invoiceId: invoice.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.field, e.oldValue, e.newValue, e.userId])).toEqual([
      ["status", "PENDING_REVIEW", "VALIDATED", w.worker.id],
      ["export", null, expect.stringMatching(/^Exportada \(batch: /), w.admin.id],
      ["registerNumber", null, "R-2026/0001", w.admin.id],
    ]);
    expect((await verifyFirmAuditChains(w.firm.id)).brokenChains).toBe(0);
  });

  it("una de abril exportada después de mayo queda marcada como registrada tarde", async () => {
    await validated({ month: 4, number: "A-1" });
    expect((await exportPeriod(4)).status).toBe(200);
    await validated({ month: 5, number: "M-1" });
    expect((await exportPeriod(5)).status).toBe(200);
    await validated({ month: 4, number: "A-TARDIA" });
    expect((await exportPeriod(4)).status).toBe(200);
    expect(await registers()).toEqual({ "A-1": "R-2026/0001", "M-1": "R-2026/0002", "A-TARDIA": "R-2026/0003" });

    const rows = await prisma.invoiceArchive.findMany({
      where: { registerNumber: { not: null }, invoice: { clientId: w.client.id } },
      select: {
        registerSeriesId: true, registerNumber: true,
        invoice: { select: { id: true, invoiceNumber: true, periodMonth: true, periodYear: true, accountingPeriodMonth: true, accountingPeriodYear: true } },
      },
    });
    const late = flagLateRegistrations(rows.map((r) => ({ ...r.invoice, registerSeriesId: r.registerSeriesId, registerNumber: r.registerNumber })));
    expect(rows.filter((r) => late.has(r.invoice.id)).map((r) => r.invoice.invoiceNumber)).toEqual(["A-TARDIA"]);
  });
});
