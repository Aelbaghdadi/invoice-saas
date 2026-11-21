// Relleno de la migración 12: el bloque entre «-- archivo:backfill:inicio» y
// «-- archivo:backfill:fin» de su migration.sql, tal cual. Una fila de archivo
// por factura; la llegada y la parte de las divisiones (numeradas por la raíz);
// electrónico o «Por confirmar»; y el nº de registro de lo ya exportado, con sus
// contadores. Es idempotente: DEPLOY.md lo vuelve a lanzar cuando el contenedor
// viejo ya está parado.
//
// Prisma manda cada consulta como sentencia preparada, que no admite varias: el
// bloque se parte por sentencias (cada una acaba en «;» al final de la línea).
// Las filas que crea el trigger se vacían con TRUNCATE, que no dispara los
// triggers de fila (con DELETE, ni con la llave, se puede: ver archiveGuards).
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { Invoice, Prisma } from "@prisma/client";
import { compareArchiveOrder, type ArchiveOrderRow } from "@/lib/archiveRules";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";

const MIGRATION = path.join(process.cwd(), "prisma", "migrations", "00000000000012_archivo", "migration.sql");

function backfillStatements(): string[] {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("-- archivo:backfill:inicio");
  const end = sql.indexOf("-- archivo:backfill:fin");
  if (start < 0 || end < start) throw new Error("Faltan las marcas del relleno en la migración 12");
  const code = sql.slice(start, end).split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n");
  return code.split(/;\s*$/m).map((statement) => statement.trim()).filter(Boolean);
}

async function runBackfill() {
  for (const statement of backfillStatements()) await prisma.$executeRawUnsafe(statement);
}

/** Sin las filas que creó el trigger, como antes de la migración. Sin el tope de
 *  15 s de la app: en un disco lento el TRUNCATE tarda (rehace los índices). */
const emptyArchive = () => prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 0");
  await tx.$executeRawUnsafe(`TRUNCATE "InvoiceArchive"`);
}, { maxWait: 10_000, timeout: 120_000 });

const at = (iso: string) => new Date(iso);

async function exportBatch(w: FirmWorld, createdAt: string, invoices: Invoice[]) {
  const batch = await prisma.exportBatch.create({
    data: { format: "a3con", clientId: w.client.id, invoiceCount: invoices.length, userId: w.admin.id, createdAt: at(createdAt) },
  });
  for (const invoice of invoices) {
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: invoice.id, snapshot: "{}", createdAt: at(createdAt) } });
  }
  return batch;
}

/** Facturas de un cliente con la historia de antes del archivo. */
async function seed() {
  const w = await makeFirm("A");
  const pdf = (overrides: Partial<Prisma.InvoiceUncheckedCreateInput>) => makeInvoice(w.client, { fileType: "application/pdf", ...overrides });

  // Electrónico o papel.
  const textPdf = await pdf({ id: "pdf-texto", createdAt: at("2026-01-05T09:00:00Z") });
  await prisma.invoiceExtraction.create({ data: { invoiceId: textPdf.id, source: "gemini_text" } });
  const scanPdf = await pdf({ id: "pdf-escaneo", createdAt: at("2026-01-06T09:00:00Z") });
  await prisma.invoiceExtraction.create({ data: { invoiceId: scanPdf.id, source: "gemini_multimodal" } });
  await makeInvoice(w.client, { id: "foto", fileType: "image/jpeg", createdAt: at("2026-01-07T09:00:00Z") });
  await makeInvoice(w.client, { id: "xml", fileType: "application/xml", createdAt: at("2026-01-08T09:00:00Z") });

  // Una división con una parte que se volvió a dividir. La segunda parte se creó
  // antes que la primera, y las nietas a la vez (desempata el id).
  const root = await pdf({ id: "div", status: "SPLIT_SOURCE", createdAt: at("2026-02-01T10:00:00Z") });
  await pdf({ id: "div-1", splitFromId: root.id, createdAt: at("2026-02-03T10:00:00Z") });
  await pdf({ id: "div-2", splitFromId: root.id, status: "SPLIT_SOURCE", createdAt: at("2026-02-02T10:00:00Z") });
  await pdf({ id: "div-2b", splitFromId: "div-2", createdAt: at("2026-02-04T10:00:00Z") });
  await pdf({ id: "div-2a", splitFromId: "div-2", createdAt: at("2026-02-04T10:00:00Z") });
  // Una raíz XML: sus partes heredan «Electrónico».
  const xmlRoot = await makeInvoice(w.client, { id: "xml-div", fileType: "application/xml", status: "SPLIT_SOURCE", createdAt: at("2026-02-10T10:00:00Z") });
  await makeInvoice(w.client, { id: "xml-div-1", fileType: "application/xml", splitFromId: xmlRoot.id, createdAt: at("2026-02-11T10:00:00Z") });

  // Exportadas en dos lotes de dos periodos. e4 es de enero pero sale en el
  // segundo; e5 es de diciembre de 2025 contabilizada en febrero de 2026.
  const purchase = (id: string, month: number, year: number, arrival: string, extra: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) =>
    pdf({ id, status: "VALIDATED", type: "PURCHASE", periodMonth: month, periodYear: year, createdAt: at(arrival), ...extra });
  const e1 = await purchase("e1", 1, 2026, "2026-02-01T08:00:00Z");
  const e2 = await purchase("e2", 1, 2026, "2026-01-20T08:00:00Z");
  const e3 = await purchase("e3", 2, 2026, "2026-02-25T08:00:00Z");
  const e4 = await purchase("e4", 1, 2026, "2026-03-01T08:00:00Z");
  const e5 = await purchase("e5", 12, 2025, "2026-02-20T08:00:00Z", { status: "EXPORTED", accountingPeriodMonth: 2, accountingPeriodYear: 2026 });
  const e6 = await purchase("e6", 12, 2025, "2026-01-02T08:00:00Z");
  // Rechazada después de exportarse (antes de las guardas de hoy): sin número.
  const rejected = await purchase("rechazada", 1, 2026, "2026-01-21T08:00:00Z", { status: "REJECTED", rejectionReason: "Duplicada" });
  // Emitidas: por fecha y nº de factura en orden natural (F-2 antes que F-10).
  const sale = (id: string, invoiceNumber: string, date: string, arrival: string) =>
    pdf({ id, status: "VALIDATED", type: "SALE", invoiceNumber, invoiceDate: at(date), periodMonth: 1, periodYear: 2026, createdAt: at(arrival) });
  const s1 = await sale("s1", "F-10", "2026-01-15T00:00:00Z", "2026-01-16T08:00:00Z");
  const s2 = await sale("s2", "F-2", "2026-01-15T00:00:00Z", "2026-01-17T08:00:00Z");
  const s3 = await sale("s3", "F-30", "2026-01-10T00:00:00Z", "2026-01-18T08:00:00Z");

  await exportBatch(w, "2026-02-05T09:00:00Z", [e1, e2, e6, rejected, s1, s2, s3]);
  // e1 se reexportó corregida: cuenta su primera exportación.
  await exportBatch(w, "2026-03-05T09:00:00Z", [e3, e4, e5, e1]);

  return { w, root };
}

async function archives() {
  const rows = await prisma.invoiceArchive.findMany({ orderBy: { invoiceId: "asc" } });
  return new Map(rows.map((row) => [row.invoiceId, row]));
}

/** Los números puestos, como se leen: «R-2026/1» (recibidas) o «E-2026/1» (emitidas). */
async function registers(): Promise<Record<string, string>> {
  const series = new Map((await prisma.invoiceRegisterSeries.findMany()).map((s) => [s.id, s]));
  const rows = await prisma.invoiceArchive.findMany({ where: { registerNumber: { not: null } } });
  return Object.fromEntries(rows.map((row) => {
    const s = series.get(row.registerSeriesId ?? "");
    return [row.invoiceId, s ? `${s.type === "SALE" ? "E" : "R"}-${s.year}/${row.registerNumber}` : `sin serie/${row.registerNumber}`];
  }));
}

describe("relleno de la migración 12", () => {
  it("rellena llegada, partes, medio y nº de registro, y los contadores", async () => {
    const { w, root } = await seed();
    await emptyArchive();
    await runBackfill();
    const rows = await archives();

    // a) Una fila por factura; sin división, la llegada es la creación.
    const invoices = await prisma.invoice.findMany();
    expect(rows.size).toBe(invoices.length);
    for (const invoice of invoices.filter((i) => !i.splitFromId)) {
      expect(rows.get(invoice.id)).toMatchObject({ receivedAt: invoice.createdAt, splitPart: 0 });
    }

    // b) Las partes llegan con su raíz y se numeran por la raíz, por createdAt e id.
    const parts = Object.fromEntries(["div-2", "div-1", "div-2a", "div-2b"].map((id) => [id, rows.get(id)?.splitPart]));
    expect(parts).toEqual({ "div-2": 1, "div-1": 2, "div-2a": 3, "div-2b": 4 });
    for (const id of ["div-1", "div-2", "div-2a", "div-2b"]) expect(rows.get(id)?.receivedAt).toEqual(root.createdAt);
    expect(rows.get("xml-div-1")).toMatchObject({ splitPart: 1, receivedAt: at("2026-02-10T10:00:00Z") });

    // c) Electrónico o «Por confirmar», sin mirar la extracción.
    const medium = (id: string) => {
      const row = rows.get(id);
      return [row?.originalMedium, row?.originalMediumSource, row?.originalMediumReason];
    };
    expect(medium("xml")).toEqual(["ELECTRONIC", "AUTO", "xml"]);
    expect(medium("foto")).toEqual([null, "AUTO", "image_unconfirmed"]);
    expect(medium("pdf-texto")).toEqual([null, "AUTO", "backfill_pending"]);
    expect(medium("pdf-escaneo")).toEqual([null, "AUTO", "backfill_pending"]);
    expect(medium(w.invoices.pending.id)).toEqual([null, "AUTO", "backfill_pending"]);
    expect(medium("div")).toEqual([null, "AUTO", "backfill_pending"]);
    for (const id of ["div-1", "div-2", "div-2a", "div-2b"]) expect(medium(id)).toEqual([null, "AUTO", "split"]);
    expect(medium("xml-div-1")).toEqual(["ELECTRONIC", "AUTO", "split"]);
    for (const row of rows.values()) expect(row.paperHeldByClient).toBe(false);

    // d) Nº de registro por serie: primera exportación, mes, (emitidas: fecha y
    //    nº natural) y llegada.
    expect(await registers()).toEqual({
      e2: "R-2026/1", e1: "R-2026/2", e4: "R-2026/3", e5: "R-2026/4", e3: "R-2026/5",
      e6: "R-2025/1",
      s3: "E-2026/1", s2: "E-2026/2", s1: "E-2026/3",
    });
    expect(rows.get("e1")?.registeredAt).toEqual(at("2026-02-05T09:00:00Z"));
    expect(rows.get("e3")?.registeredAt).toEqual(at("2026-03-05T09:00:00Z"));
    expect(rows.get("rechazada")?.registerNumber).toBeNull();
    expect(rows.get(w.invoices.validated.id)?.registerNumber).toBeNull();

    const series = await prisma.invoiceRegisterSeries.findMany({ orderBy: [{ type: "asc" }, { year: "asc" }] });
    expect(series.map((s) => [s.clientId, s.type, s.year, s.lastNumber])).toEqual([
      [w.client.id, "PURCHASE", 2025, 1],
      [w.client.id, "PURCHASE", 2026, 5],
      [w.client.id, "SALE", 2026, 3],
    ]);
  });

  it("ejecutarlo otra vez no cambia nada", async () => {
    await seed();
    await emptyArchive();
    await runBackfill();
    const first = { rows: await archives(), series: await prisma.invoiceRegisterSeries.findMany({ orderBy: { id: "asc" } }) };
    await runBackfill();
    expect({ rows: await archives(), series: await prisma.invoiceRegisterSeries.findMany({ orderBy: { id: "asc" } }) }).toEqual(first);
  });

  it("la segunda pasada solo completa lo que dejó el código viejo después de la migración", async () => {
    const { w, root } = await seed();
    await emptyArchive();
    await runBackfill();
    const before = await archives();

    // El contenedor viejo sigue vivo un rato: sube, divide y exporta. Las filas
    // nuevas las crea el trigger, sin medio, sin parte y sin número.
    const upload = await makeInvoice(w.client, { id: "subida-vieja", fileType: "application/pdf", createdAt: at("2026-03-09T08:00:00Z") });
    const newPart = await makeInvoice(w.client, { id: "div-3", fileType: "application/pdf", splitFromId: root.id, createdAt: at("2026-03-10T08:00:00Z") });
    const late = await makeInvoice(w.client, { id: "e7", status: "VALIDATED", periodMonth: 3, periodYear: 2026, createdAt: at("2026-03-20T08:00:00Z") });
    await exportBatch(w, "2026-04-02T09:00:00Z", [late]);

    await runBackfill();
    const after = await archives();
    expect(after.get(upload.id)).toMatchObject({ originalMediumSource: "AUTO", originalMediumReason: "backfill_pending", receivedAt: upload.createdAt });
    expect(after.get(newPart.id)).toMatchObject({ splitPart: 5, receivedAt: root.createdAt, originalMediumReason: "split" });
    expect((await registers())[late.id]).toBe("R-2026/6");
    expect((await prisma.invoiceRegisterSeries.findFirstOrThrow({ where: { clientId: w.client.id, type: "PURCHASE", year: 2026 } })).lastNumber).toBe(6);
    // Lo que ya estaba, igual (también su updatedAt).
    for (const [id, row] of before) expect(after.get(id)).toEqual(row);
  });

  it("las emitidas del mismo lote y fecha van en el orden del archivo (compareArchiveOrder)", async () => {
    const w = await makeFirm("A");
    const sale = (id: string, invoiceNumber: string | null, arrival: string, extra: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) =>
      makeInvoice(w.client, {
        id, status: "VALIDATED", type: "SALE", invoiceNumber, invoiceDate: at("2026-01-15T00:00:00Z"),
        periodMonth: 1, periodYear: 2026, createdAt: at(arrival), ...extra,
      });
    const sales = [
      await sale("v-vacio", "", "2026-01-16T08:00:00Z"),
      await sale("v-null", null, "2026-01-16T09:00:00Z"),
      await sale("v-ABD", "ABD", "2026-01-16T10:00:00Z"),
      await sale("v-abc", "abc", "2026-01-16T11:00:00Z"),
      await sale("v-F2", " F-2 ", "2026-01-16T12:00:00Z"),
    ];
    // Dos partes de una división, sin nº: comparten fecha y llegada, y en las
    // emitidas desempata el id, no la parte.
    const root = await makeInvoice(w.client, { id: "v-div", type: "SALE", status: "SPLIT_SOURCE", createdAt: at("2026-01-17T08:00:00Z") });
    sales.push(await sale("v-div-b", null, "2026-01-17T09:00:00Z", { splitFromId: root.id }));
    sales.push(await sale("v-div-a", null, "2026-01-17T10:00:00Z", { splitFromId: root.id }));
    await exportBatch(w, "2026-02-05T09:00:00Z", sales);

    await emptyArchive();
    await runBackfill();

    // Primero las que tienen dígitos; después las que no, sin mirar mayúsculas;
    // al final las vacías, por llegada e id.
    expect(await registers()).toEqual({
      "v-F2": "E-2026/1", "v-abc": "E-2026/2", "v-ABD": "E-2026/3", "v-vacio": "E-2026/4", "v-null": "E-2026/5",
      "v-div-a": "E-2026/6", "v-div-b": "E-2026/7",
    });
    const numbered = await prisma.invoice.findMany({ where: { id: { in: sales.map((s) => s.id) } }, include: { archive: true } });
    const rows: (ArchiveOrderRow & { number: number })[] = numbered.map((invoice) => ({
      id: invoice.id, type: invoice.type, periodType: invoice.periodType, periodMonth: invoice.periodMonth, periodYear: invoice.periodYear,
      accountingPeriodMonth: invoice.accountingPeriodMonth, accountingPeriodYear: invoice.accountingPeriodYear,
      receivedAt: invoice.archive!.receivedAt, uploadPosition: invoice.archive!.uploadPosition, splitPart: invoice.archive!.splitPart,
      createdAt: invoice.createdAt, invoiceDate: invoice.invoiceDate, invoiceNumber: invoice.invoiceNumber,
      number: invoice.archive!.registerNumber!,
    }));
    expect([...rows].sort((a, b) => a.number - b.number).map((r) => r.id)).toEqual([...rows].sort(compareArchiveOrder).map((r) => r.id));
  });

  it("la primera exportación es la fecha del lote, no la de sus items", async () => {
    const w = await makeFirm("A");
    const purchase = (id: string, arrival: string) =>
      makeInvoice(w.client, { id, status: "VALIDATED", periodMonth: 1, periodYear: 2026, createdAt: at(arrival) });
    const january = await purchase("lote-enero", "2026-01-20T08:00:00Z");
    const march = await purchase("lote-marzo", "2026-01-05T08:00:00Z");
    const batch = (createdAt: string) => prisma.exportBatch.create({
      data: { format: "a3con", clientId: w.client.id, invoiceCount: 1, userId: w.admin.id, createdAt: at(createdAt) },
    });
    // El lote se crea en una consulta y sus items en otra, ya en febrero; y los
    // items que creó scripts/backfill-hardening.ts llevan la fecha del script,
    // en el orden en que los fue encontrando.
    const januaryBatch = await batch("2026-01-31T23:59:59.900Z");
    const marchBatch = await batch("2026-03-02T09:00:00Z");
    await prisma.exportBatchItem.create({ data: { exportBatchId: marchBatch.id, invoiceId: march.id, snapshot: "{}", createdAt: at("2026-04-15T10:00:00.100Z") } });
    await prisma.exportBatchItem.create({ data: { exportBatchId: januaryBatch.id, invoiceId: january.id, snapshot: "{}", createdAt: at("2026-04-15T10:00:00.200Z") } });

    await emptyArchive();
    await runBackfill();

    expect(await registers()).toEqual({ "lote-enero": "R-2026/1", "lote-marzo": "R-2026/2" });
    const rows = await archives();
    expect(rows.get("lote-enero")?.registeredAt).toEqual(at("2026-01-31T23:59:59.900Z"));
    expect(rows.get("lote-marzo")?.registeredAt).toEqual(at("2026-03-02T09:00:00Z"));
  });

  it("sigue desde el mayor número de una serie que ya existía", async () => {
    const w = await makeFirm("A");
    const series = await prisma.invoiceRegisterSeries.create({ data: { clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 41 } });
    const numbered = await makeInvoice(w.client, { status: "VALIDATED", periodMonth: 1, periodYear: 2026 });
    await prisma.invoiceArchive.update({ where: { invoiceId: numbered.id }, data: { registerSeriesId: series.id, registerNumber: 41, registeredAt: at("2026-02-01T00:00:00Z") } });
    const pending = await makeInvoice(w.client, { status: "VALIDATED", periodMonth: 2, periodYear: 2026 });
    await exportBatch(w, "2026-03-01T09:00:00Z", [numbered, pending]);

    await runBackfill();
    expect((await registers())[pending.id]).toBe("R-2026/42");
    expect((await prisma.invoiceRegisterSeries.findUniqueOrThrow({ where: { id: series.id } })).lastNumber).toBe(42);
  });
});
