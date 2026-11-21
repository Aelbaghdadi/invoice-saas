// Guardas del archivo (migración 12). La fila de archivo de cada factura la crea
// un trigger, y otros impiden borrar facturas, documentos y filas de archivo
// (salvo el reset de una asesoría de demo), cambiar el fichero, el nº de
// registro o la tanda de llegada, poner el nº a medias o en otra serie, cambiar
// una serie o bajar su contador, dejar el papel sin taco y cambiar el nº de un
// taco. Cada guarda lleva su mutante: sin su trigger (DROP TRIGGER en una
// transacción que se deshace), lo prohibido sale bien.
import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";

class Rollback extends Error {}

/** Margen para una BD de pruebas lenta: lo que se prueba no es el tiempo. */
const TX = { maxWait: 10_000, timeout: 30_000 };

/** Mutante: `act` con el trigger quitado, en una transacción que se deshace. */
async function withoutTrigger<T>(
  table: string,
  trigger: string,
  act: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`DROP TRIGGER ${trigger} ON "${table}"`);
    result = await act(tx);
    throw new Rollback();
  }, TX).catch((err) => {
    if (!(err instanceof Rollback)) throw err;
  });
  return result as T;
}

/** Con la llave del reset de la demo (SET LOCAL dentro de la transacción), como demoSeed. */
const withBypass = <T>(act: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_audit_mutation = 'true'`);
    return act(tx);
  }, TX);

/** Los SQLSTATE y los mensajes que trae un error de Prisma (con adapter-pg van anidados). */
function errorDetails(err: unknown): { codes: string[]; text: string } {
  const codes: string[] = [];
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return;
    seen.add(value);
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (typeof inner === "string" && /^(code|originalCode)$/.test(key)) codes.push(inner);
      else if (typeof inner === "string" && /message/i.test(key)) texts.push(inner);
      else visit(inner, depth + 1);
    }
    if (value instanceof Error) {
      texts.push(value.message);
      visit((value as { cause?: unknown }).cause, depth + 1);
    }
  };
  visit(err, 0);
  return { codes, text: texts.join("\n") };
}

/** Falla por una guarda del archivo: check_violation con su mensaje en castellano. */
async function expectGuard(action: Promise<unknown>, message: RegExp) {
  const err = await action.then(() => null, (e: unknown) => e);
  expect(err, "la operación tenía que fallar").not.toBeNull();
  const { codes, text } = errorDetails(err);
  expect(codes).toContain("23514");
  expect(text).toMatch(message);
}

const archiveRow = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });

async function makeDocument(w: FirmWorld, overrides: Partial<Prisma.DocumentUncheckedCreateInput> = {}) {
  return prisma.document.create({
    data: { filename: "d.pdf", storageKey: `${w.client.id}/2026-09/d-${Math.random()}.pdf`, fileType: "application/pdf", clientId: w.client.id, ...overrides },
  });
}

async function makeBatch(w: FirmWorld, data: Partial<Prisma.UploadBatchUncheckedCreateInput> = {}) {
  return prisma.uploadBatch.create({
    data: { advisoryFirmId: w.firm.id, clientId: w.client.id, createdById: w.worker.id, fileCount: 3, periodYear: 2026, ...data },
  });
}

const invoiceData = (w: FirmWorld, id: string, createdAt: Date) => ({
  id, clientId: w.client.id, filename: `${id}.pdf`, storageKey: `${w.client.id}/${id}.pdf`, fileType: "application/pdf",
  type: "PURCHASE" as const, periodMonth: 9, periodYear: 2026, createdAt,
});

describe("la fila de archivo la crea un trigger", () => {
  it("create y createMany dejan una fila por factura, con la llegada = createdAt", async () => {
    const w = await makeFirm("A");
    const one = await prisma.invoice.create({ data: invoiceData(w, "uno", new Date("2026-03-01T10:00:00.123Z")) });
    await prisma.invoice.createMany({
      data: [invoiceData(w, "dos", new Date("2026-03-02T08:30:00Z")), invoiceData(w, "tres", new Date("2026-03-03T23:59:59.999Z"))],
    });
    for (const id of [one.id, "dos", "tres", w.invoices.pending.id, w.invoices.validated.id]) {
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(await archiveRow(id)).toMatchObject({
        receivedAt: invoice.createdAt,
        createdAt: invoice.createdAt,
        uploadBatchId: null,
        uploadPosition: null,
        splitPart: 0,
        paperBatchId: null,
        paperHeldByClient: false,
        originalMedium: null,
        originalMediumSource: null,
        originalMediumReason: null,
        registerNumber: null,
        retentionHold: false,
      });
    }
    expect(await prisma.invoiceArchive.count()).toBe(await prisma.invoice.count());
  });

  it("mutante: sin el trigger, la factura nueva se queda sin fila", async () => {
    const w = await makeFirm("A");
    const rows = await withoutTrigger("Invoice", "invoice_archive_row", async (tx) => {
      await tx.invoice.create({ data: invoiceData(w, "sin-fila", new Date()) });
      return tx.invoiceArchive.count({ where: { invoiceId: "sin-fila" } });
    });
    expect(rows).toBe(0);
  });

  it("archive: { create } anidado choca con la fila del trigger y no deja nada", async () => {
    const w = await makeFirm("A");
    await expect(prisma.invoice.create({
      data: { ...invoiceData(w, "anidada", new Date()), archive: { create: { retentionHold: true } } },
    })).rejects.toThrow();
    expect(await prisma.invoice.count({ where: { id: "anidada" } })).toBe(0);
  });
});

describe("nada borra una factura, un documento ni una fila de archivo", () => {
  const BORRAR = /Archivo: no se borran facturas ni originales/;
  const BORRAR_FILA = /Archivo: la fila de archivo de una factura no se borra/;

  it("DELETE de Invoice, Document o InvoiceArchive da check_violation", async () => {
    const w = await makeFirm("A");
    const doc = await makeDocument(w);
    await expectGuard(prisma.invoice.delete({ where: { id: w.invoices.pending.id } }), BORRAR);
    await expectGuard(prisma.document.delete({ where: { id: doc.id } }), BORRAR);
    await expectGuard(prisma.invoiceArchive.delete({ where: { invoiceId: w.invoices.pending.id } }), BORRAR_FILA);
    await expectGuard(prisma.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE "clientId" = $1`, w.client.id), BORRAR);
    expect(await prisma.invoice.count({ where: { clientId: w.client.id } })).toBe(2);
    expect(await prisma.document.count({ where: { id: doc.id } })).toBe(1);
    expect(await prisma.invoiceArchive.count({ where: { invoice: { clientId: w.client.id } } })).toBe(2);
  });

  it("con la llave (app.allow_audit_mutation) pero sin isDemo, tampoco", async () => {
    const w = await makeFirm("A");
    const doc = await makeDocument(w);
    await expectGuard(withBypass((tx) => tx.invoice.delete({ where: { id: w.invoices.pending.id } })), BORRAR);
    await expectGuard(withBypass((tx) => tx.document.delete({ where: { id: doc.id } })), BORRAR);
    await expectGuard(withBypass((tx) => tx.invoiceArchive.delete({ where: { invoiceId: w.invoices.pending.id } })), BORRAR_FILA);
    expect(await prisma.invoice.count({ where: { id: w.invoices.pending.id } })).toBe(1);
    expect(await prisma.document.count({ where: { id: doc.id } })).toBe(1);
  });

  it("con isDemo pero sin la llave, tampoco", async () => {
    const w = await makeFirm("A", { demo: true });
    const doc = await makeDocument(w);
    await expectGuard(prisma.invoice.delete({ where: { id: w.invoices.pending.id } }), BORRAR);
    await expectGuard(prisma.document.delete({ where: { id: doc.id } }), BORRAR);
  });

  it("con isDemo y la llave dentro de una transacción, sí borra (la fila de archivo se va en cascada)", async () => {
    const w = await makeFirm("A", { demo: true });
    const other = await makeFirm("B");
    const doc = await makeDocument(w);
    await withBypass(async (tx) => {
      await tx.invoice.deleteMany({ where: { clientId: w.client.id } });
      await tx.document.delete({ where: { id: doc.id } });
    });
    expect(await prisma.invoice.count({ where: { clientId: w.client.id } })).toBe(0);
    expect(await prisma.invoiceArchive.count({ where: { invoiceId: { in: [w.invoices.pending.id, w.invoices.validated.id] } } })).toBe(0);
    expect(await prisma.document.count({ where: { id: doc.id } })).toBe(0);
    // La llave no sale de su transacción ni de la asesoría de demo.
    await expectGuard(prisma.invoice.delete({ where: { id: other.invoices.pending.id } }), BORRAR);
    await expectGuard(withBypass((tx) => tx.invoice.delete({ where: { id: other.invoices.pending.id } })), BORRAR);
  });

  it("la fila de archivo no se borra con su factura viva, ni con la llave en una asesoría de demo", async () => {
    const w = await makeFirm("A", { demo: true });
    await expectGuard(withBypass((tx) => tx.invoiceArchive.delete({ where: { invoiceId: w.invoices.pending.id } })), BORRAR_FILA);
    await expectGuard(
      withBypass((tx) => tx.$executeRawUnsafe(`DELETE FROM "InvoiceArchive" WHERE "invoiceId" = $1`, w.invoices.pending.id)),
      BORRAR_FILA,
    );
    expect(await prisma.invoiceArchive.count({ where: { invoiceId: w.invoices.pending.id } })).toBe(1);
  });

  it("un cliente con facturas no se puede borrar: la cascada choca con el trigger, también en la demo con la llave", async () => {
    const real = await makeFirm("A");
    const demo = await makeFirm("B", { demo: true });
    await expectGuard(prisma.client.delete({ where: { id: real.client.id } }), BORRAR);
    await expectGuard(withBypass((tx) => tx.client.delete({ where: { id: demo.client.id } })), BORRAR);
    expect(await prisma.client.count({ where: { id: { in: [real.client.id, demo.client.id] } } })).toBe(2);
    expect(await prisma.invoice.count()).toBe(4);
  });

  it("un cliente con un documento suelto tampoco; uno sin facturas ni documentos, sí", async () => {
    const w = await makeFirm("A");
    const onlyDocument = await prisma.client.create({ data: { name: "Solo documento SL", cif: "B99999990", advisoryFirmId: w.firm.id } });
    await makeDocument(w, { clientId: onlyDocument.id });
    await expectGuard(prisma.client.delete({ where: { id: onlyDocument.id } }), BORRAR);
    const empty = await prisma.client.create({ data: { name: "Vacío SL", cif: "B99999991", advisoryFirmId: w.firm.id } });
    await makeBatch(w, { clientId: empty.id });
    await prisma.invoiceRegisterSeries.create({ data: { clientId: empty.id, type: "PURCHASE", year: 2026 } });
    await prisma.client.delete({ where: { id: empty.id } });
    expect(await prisma.client.count({ where: { id: empty.id } })).toBe(0);
  });

  it("mutantes: sin cada trigger, el borrado sale bien", async () => {
    const w = await makeFirm("A");
    const doc = await makeDocument(w);
    const id = w.invoices.pending.id;
    expect(await withoutTrigger("Invoice", "archive_no_delete_by_client",
      (tx) => tx.$executeRawUnsafe(`DELETE FROM "Invoice" WHERE "id" = $1`, id))).toBe(1);
    expect(await withoutTrigger("Document", "archive_no_delete_by_client",
      (tx) => tx.$executeRawUnsafe(`DELETE FROM "Document" WHERE "id" = $1`, doc.id))).toBe(1);
    expect(await withoutTrigger("InvoiceArchive", "archive_row_no_delete",
      (tx) => tx.$executeRawUnsafe(`DELETE FROM "InvoiceArchive" WHERE "invoiceId" = $1`, id))).toBe(1);
    // El del cliente (sin documentos): lo que lo para es el trigger de "Invoice" en la cascada.
    const other = await makeFirm("B");
    expect(await withoutTrigger("Invoice", "archive_no_delete_by_client",
      (tx) => tx.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, other.client.id))).toBe(1);
    // Todo se ha deshecho.
    expect(await prisma.invoice.count({ where: { id } })).toBe(1);
    expect(await prisma.invoiceArchive.count({ where: { invoiceId: id } })).toBe(1);
    expect(await prisma.document.count({ where: { id: doc.id } })).toBe(1);
    expect(await prisma.client.count({ where: { id: other.client.id } })).toBe(1);
  });
});

describe("el fichero de una factura o de un documento no cambia", () => {
  const FICHERO = /Archivo: no se cambia el fichero/;
  const HUELLA = /Archivo: no se cambia la huella del fichero/;

  it("ni storageKey ni un fileHash ya puesto; un fileHash vacío sí se rellena", async () => {
    const w = await makeFirm("A");
    const invoice = await makeInvoice(w.client, { fileHash: null });
    const doc = await makeDocument(w, { fileHash: null });

    await expectGuard(prisma.invoice.update({ where: { id: invoice.id }, data: { storageKey: "otra-clave.pdf" } }), FICHERO);
    await expectGuard(prisma.document.update({ where: { id: doc.id }, data: { storageKey: "otra-clave.pdf" } }), FICHERO);

    await prisma.invoice.update({ where: { id: invoice.id }, data: { fileHash: "huella-1" } });
    await prisma.document.update({ where: { id: doc.id }, data: { fileHash: "huella-1" } });
    await expectGuard(prisma.invoice.update({ where: { id: invoice.id }, data: { fileHash: "huella-2" } }), HUELLA);
    await expectGuard(prisma.document.update({ where: { id: doc.id }, data: { fileHash: "huella-2" } }), HUELLA);
    await expectGuard(prisma.invoice.update({ where: { id: invoice.id }, data: { fileHash: null } }), HUELLA);

    // Escribir el mismo valor no es un cambio.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { storageKey: invoice.storageKey, fileHash: "huella-1" } });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ storageKey: invoice.storageKey, fileHash: "huella-1" });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({ storageKey: doc.storageKey, fileHash: "huella-1" });
  });

  it("mutantes: sin el trigger, la clave y la huella cambian", async () => {
    const w = await makeFirm("A");
    const invoice = await makeInvoice(w.client, { fileHash: "huella-1" });
    const doc = await makeDocument(w, { fileHash: "huella-1" });
    expect(await withoutTrigger("Invoice", "archive_file_guard",
      (tx) => tx.invoice.update({ where: { id: invoice.id }, data: { storageKey: "otra.pdf", fileHash: "huella-2" } }))).toMatchObject({ storageKey: "otra.pdf", fileHash: "huella-2" });
    expect(await withoutTrigger("Document", "archive_file_guard",
      (tx) => tx.document.update({ where: { id: doc.id }, data: { storageKey: "otra.pdf", fileHash: "huella-2" } }))).toMatchObject({ storageKey: "otra.pdf", fileHash: "huella-2" });
  });
});

describe("el nº de registro no cambia", () => {
  const NUMERO = /Archivo: el nº de registro no cambia/;
  const CLIENTE = /Archivo: una factura con nº de registro no cambia de cliente/;

  async function registered() {
    const w = await makeFirm("A");
    const series = await prisma.invoiceRegisterSeries.create({ data: { clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 1 } });
    const other = await prisma.invoiceRegisterSeries.create({ data: { clientId: w.client.id, type: "PURCHASE", year: 2025 } });
    const id = w.invoices.validated.id;
    const registeredAt = new Date("2026-10-03T09:00:00Z");
    // Ponerlo la primera vez sí se puede.
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { registerSeriesId: series.id, registerNumber: 1, registeredAt } });
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B99999992", advisoryFirmId: w.firm.id } });
    return { w, id, series, other, registeredAt, otherClient };
  }

  it("con número puesto no cambian el número, la serie, la fecha ni el cliente de la factura", async () => {
    const { w, id, other, registeredAt, otherClient } = await registered();
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { registerNumber: 2 } }), NUMERO);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { registerNumber: null, registerSeriesId: null } }), NUMERO);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { registerSeriesId: other.id } }), NUMERO);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { registeredAt: new Date() } }), NUMERO);
    await expectGuard(prisma.invoice.update({ where: { id }, data: { clientId: otherClient.id } }), CLIENTE);

    // Lo demás de la fila sí se edita, y una factura sin número sí cambia de cliente (clasificar).
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { retentionHold: true, retentionHoldReason: "FIXED_ASSET" } });
    await prisma.invoice.update({ where: { id: w.invoices.pending.id }, data: { clientId: otherClient.id } });
    expect(await archiveRow(id)).toMatchObject({ registerNumber: 1, registeredAt, retentionHold: true });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).clientId).toBe(w.client.id);
  });

  it("mutantes: sin los triggers, el número y el cliente cambian", async () => {
    const { id, otherClient } = await registered();
    expect(await withoutTrigger("InvoiceArchive", "archive_row_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: id }, data: { registerNumber: 7 } }))).toMatchObject({ registerNumber: 7 });
    expect(await withoutTrigger("Invoice", "invoice_registered_client_guard",
      (tx) => tx.invoice.update({ where: { id }, data: { clientId: otherClient.id } }))).toMatchObject({ clientId: otherClient.id });
  });

  const A_MEDIAS = /Archivo: el nº de registro se pone con su serie y su fecha/;
  const SERIE = /Archivo: la serie del nº de registro no es la del cliente, el tipo y el año de la factura/;

  it("se pone entero (número, serie y fecha) y en la serie del cliente, el tipo y el año de la factura", async () => {
    const w = await makeFirm("A");
    const id = w.invoices.validated.id; // compra de septiembre de 2026
    const registeredAt = new Date("2026-10-03T09:00:00Z");
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B99999993", advisoryFirmId: w.firm.id } });
    const series = (clientId: string, type: "PURCHASE" | "SALE", year: number) =>
      prisma.invoiceRegisterSeries.create({ data: { clientId, type, year, lastNumber: 1 } });
    const own = await series(w.client.id, "PURCHASE", 2026);
    const lastYear = await series(w.client.id, "PURCHASE", 2025);
    const wrong = [await series(otherClient.id, "PURCHASE", 2026), await series(w.client.id, "SALE", 2026), lastYear];
    const set = (data: Prisma.InvoiceArchiveUncheckedUpdateInput, invoiceId = id) =>
      prisma.invoiceArchive.update({ where: { invoiceId }, data });

    await expectGuard(set({ registerNumber: 7 }), A_MEDIAS);
    await expectGuard(set({ registerSeriesId: own.id, registerNumber: 1 }), A_MEDIAS);
    await expectGuard(set({ registeredAt }), A_MEDIAS);
    for (const other of wrong) await expectGuard(set({ registerSeriesId: other.id, registerNumber: 1, registeredAt }), SERIE);
    expect(await archiveRow(id)).toMatchObject({ registerSeriesId: null, registerNumber: null, registeredAt: null });

    await set({ registerSeriesId: own.id, registerNumber: 1, registeredAt });
    expect(await archiveRow(id)).toMatchObject({ registerSeriesId: own.id, registerNumber: 1, registeredAt });
    // El año es el del periodo de deducción: contabilizada en diciembre de 2025, va a la serie de 2025.
    await prisma.invoice.update({ where: { id: w.invoices.pending.id }, data: { accountingPeriodMonth: 12, accountingPeriodYear: 2025 } });
    await set({ registerSeriesId: lastYear.id, registerNumber: 1, registeredAt }, w.invoices.pending.id);
    expect(await archiveRow(w.invoices.pending.id)).toMatchObject({ registerSeriesId: lastYear.id, registerNumber: 1 });
  });

  it("mutante: sin el trigger, el nº se pone a medias o en la serie de otro cliente", async () => {
    const w = await makeFirm("A");
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B99999994", advisoryFirmId: w.firm.id } });
    const foreign = await prisma.invoiceRegisterSeries.create({ data: { clientId: otherClient.id, type: "SALE", year: 2024 } });
    const id = w.invoices.validated.id;
    expect(await withoutTrigger("InvoiceArchive", "archive_row_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: id }, data: { registerNumber: 7 } })))
      .toMatchObject({ registerSeriesId: null, registerNumber: 7, registeredAt: null });
    expect(await withoutTrigger("InvoiceArchive", "archive_row_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: id }, data: { registerSeriesId: foreign.id, registerNumber: 1, registeredAt: new Date() } })))
      .toMatchObject({ registerSeriesId: foreign.id, registerNumber: 1 });
  });
});

describe("una serie de registro no cambia de cliente, tipo ni año, y su contador solo sube", () => {
  const FIJA = /Archivo: una serie de registro no cambia de cliente, tipo ni año/;
  const BAJA = /Archivo: el último nº de una serie de registro no baja/;

  it("cambiar el cliente, el tipo o el año, o bajar el contador, falla; reservar como al exportar, no", async () => {
    const w = await makeFirm("A");
    const otherClient = await prisma.client.create({ data: { name: "Otra SL", cif: "B99999995", advisoryFirmId: w.firm.id } });
    const series = await prisma.invoiceRegisterSeries.create({ data: { clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 1 } });
    await prisma.invoiceArchive.update({
      where: { invoiceId: w.invoices.validated.id },
      data: { registerSeriesId: series.id, registerNumber: 1, registeredAt: new Date("2026-10-03T09:00:00Z") },
    });
    const update = (data: Prisma.InvoiceRegisterSeriesUncheckedUpdateInput) =>
      prisma.invoiceRegisterSeries.update({ where: { id: series.id }, data });

    await expectGuard(update({ year: 2025 }), FIJA);
    await expectGuard(update({ type: "SALE" }), FIJA);
    await expectGuard(update({ clientId: otherClient.id }), FIJA);
    await expectGuard(update({ lastNumber: 0 }), BAJA);

    // La reserva del export: INSERT … ON CONFLICT DO UPDATE sube el contador.
    const [reserved] = await prisma.$queryRawUnsafe<{ lastNumber: number }[]>(
      `INSERT INTO "InvoiceRegisterSeries" ("id", "clientId", "type", "year", "lastNumber", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'PURCHASE', 2026, 2, now() AT TIME ZONE 'UTC')
       ON CONFLICT ("clientId", "type", "year") DO UPDATE
         SET "lastNumber" = "InvoiceRegisterSeries"."lastNumber" + 2, "updatedAt" = now() AT TIME ZONE 'UTC'
       RETURNING "lastNumber"`,
      w.client.id,
    );
    expect(reserved.lastNumber).toBe(3);
    expect(await prisma.invoiceRegisterSeries.findUniqueOrThrow({ where: { id: series.id } }))
      .toMatchObject({ clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 3 });
  });

  it("mutante: sin el trigger, la serie cambia de año y el contador baja", async () => {
    const w = await makeFirm("A");
    const series = await prisma.invoiceRegisterSeries.create({ data: { clientId: w.client.id, type: "PURCHASE", year: 2026, lastNumber: 5 } });
    expect(await withoutTrigger("InvoiceRegisterSeries", "register_series_guard",
      (tx) => tx.invoiceRegisterSeries.update({ where: { id: series.id }, data: { year: 2024, lastNumber: 0 } })))
      .toMatchObject({ year: 2024, lastNumber: 0 });
  });
});

describe("la tanda de llegada y el taco del papel", () => {
  const TANDA = /Archivo: la tanda de llegada no cambia/;
  const POSICION = /Archivo: la posición en la tanda no cambia/;
  const PAPEL = /Archivo: el papel no se queda sin taco/;

  it("la tanda y la posición, puestas, no cambian ni vuelven a vacío; el taco del papel no vuelve a vacío; el original adjunto sí se quita", async () => {
    const w = await makeFirm("A");
    const arrival = await makeBatch(w);
    const otherArrival = await makeBatch(w);
    const taco = await makeBatch(w, { tacoNumber: 1, origin: "ARCHIVE" });
    const otherTaco = await makeBatch(w, { tacoNumber: 2, origin: "ARCHIVE" });
    const word = await makeDocument(w, { filename: "original.doc", fileType: "application/msword" });
    const id = w.invoices.pending.id;

    // Del alta (vacío → valor), sí.
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: arrival.id, uploadPosition: 2 } });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: null, uploadPosition: null } }), TANDA);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: otherArrival.id } }), TANDA);
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadPosition: 3 } }), POSICION);

    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: taco.id } });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: otherTaco.id } });
    await expectGuard(prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { paperBatchId: null } }), PAPEL);

    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { originalDocumentId: word.id } });
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { originalDocumentId: null } });

    expect(await archiveRow(id)).toMatchObject({
      uploadBatchId: arrival.id, uploadPosition: 2, paperBatchId: otherTaco.id, originalDocumentId: null,
    });
    expect(await prisma.document.count({ where: { id: word.id } })).toBe(1);
  });

  it("mutante: sin el trigger, la fila se queda sin tanda", async () => {
    const w = await makeFirm("A");
    const arrival = await makeBatch(w);
    const id = w.invoices.pending.id;
    await prisma.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: arrival.id, uploadPosition: 1 } });
    expect(await withoutTrigger("InvoiceArchive", "archive_row_guard",
      (tx) => tx.invoiceArchive.update({ where: { invoiceId: id }, data: { uploadBatchId: null, uploadPosition: null } })))
      .toMatchObject({ uploadBatchId: null, uploadPosition: null });
  });
});

describe("el nº de un taco no cambia", () => {
  const TACO = /Archivo: el nº de un taco no cambia/;

  it("se pone una vez (tanda digital → taco) y ya no cambia ni se quita", async () => {
    const w = await makeFirm("A");
    const batch = await makeBatch(w);
    await prisma.uploadBatch.update({ where: { id: batch.id }, data: { tacoNumber: 37 } });
    await expectGuard(prisma.uploadBatch.update({ where: { id: batch.id }, data: { tacoNumber: 38 } }), TACO);
    await expectGuard(prisma.uploadBatch.update({ where: { id: batch.id }, data: { tacoNumber: null } }), TACO);
    // Guardarlo en una caja sí.
    await prisma.uploadBatch.update({ where: { id: batch.id }, data: { boxLabel: "Cliente A · 2026 · Caja 1", filedAt: new Date() } });
    expect(await prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({ tacoNumber: 37, boxLabel: "Cliente A · 2026 · Caja 1" });
  });

  it("mutante: sin el trigger, el nº cambia", async () => {
    const w = await makeFirm("A");
    const batch = await makeBatch(w, { tacoNumber: 37 });
    expect(await withoutTrigger("UploadBatch", "taco_number_guard",
      (tx) => tx.uploadBatch.update({ where: { id: batch.id }, data: { tacoNumber: 38 } }))).toMatchObject({ tacoNumber: 38 });
  });
});

describe("las ediciones de la fila de archivo no tocan la factura", () => {
  it("Invoice.updatedAt sigue igual", async () => {
    const w = await makeFirm("A");
    const id = w.invoices.pending.id;
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    await prisma.invoiceArchive.update({
      where: { invoiceId: id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual", retentionHold: true },
    });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(before.updatedAt);
  });
});
