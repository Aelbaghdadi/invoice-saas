// Dividir (PR #4, F-056): se reserva la original antes de crear las hijas.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, PNG_DATA_URL } from "./helpers/fixtures";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { signInAs } from "./helpers/session";
import { splitInvoice, splitPdfInvoice } from "@/app/dashboard/worker/review/[id]/actions";

let w: FirmWorld;
let id: string;
const parts = [{ name: "a", startPage: 1, endPage: 1 }, { name: "b", startPage: 2, endPage: 2 }];

beforeEach(async () => {
  w = await makeFirm("A");
  fakeS3().put("k-pdf", await blankPdf(2));
  ({ id } = await makeInvoice(w.client, { storageKey: "k-pdf" }));
  signInAs(w.worker);
});

// { error } o redireccion (exito).
const settle = (p: Promise<{ error?: string } | void>) => p.then(
  (r) => ({ error: r?.error ?? null }),
  (e) => (e?.message === "NEXT_REDIRECT" ? { error: null } : Promise.reject(e)),
);
const run = () => settle(splitPdfInvoice(id, parts, "all"));
const runImage = () => settle(splitInvoice(id, [{ name: "t1", dataUrl: PNG_DATA_URL }, { name: "t2", dataUrl: PNG_DATA_URL }], "all"));
const children = () => prisma.invoice.count({ where: { splitFromId: id } });
const status = async () => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).status;
const splitKeys = () => fakeS3().keys().filter((k) => k.includes("-split-"));

describe("dividir reserva antes la original", () => {
  it("camino normal: original SPLIT_SOURCE, dos hijas, historial y auditoría", async () => {
    expect(await run()).toEqual({ error: null });
    expect(await status()).toBe("SPLIT_SOURCE");
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id, toStatus: "SPLIT_SOURCE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { invoiceId: id, newValue: "SPLIT_SOURCE" } })).toBe(1);
  });

  it("cierra las incidencias abiertas de la original (F-057)", async () => {
    await prisma.invoiceIssue.create({ data: { invoiceId: id, type: "MATH_MISMATCH", description: "No cuadra" } });
    expect(await run()).toEqual({ error: null });
    const issue = await prisma.invoiceIssue.findFirstOrThrow({ where: { invoiceId: id } });
    expect([issue.status, issue.resolvedBy]).toEqual(["RESOLVED", w.worker.id]);
  });

  it("dos divisiones de PDF a la vez: solo una crea hijas y la otra no deja ficheros", async () => {
    const [a, b] = await Promise.all([inFlight(run()), inFlight(run())]);
    const errors = [a.error, b.error].filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/dividió en otras|ha cambiado/);
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id, toStatus: "SPLIT_SOURCE" } })).toBe(1);
  });

  it("dos divisiones de recortes de imagen a la vez: solo una crea hijas", async () => {
    await prisma.invoice.update({ where: { id }, data: { fileType: "image/png" } });
    const [a, b] = await Promise.all([runImage(), runImage()]);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
  });

  it("exportada: no se divide y no quedan ficheros", async () => {
    await prisma.exportBatch.create({ data: { id: "b1", format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED", exportBatchId: "b1" } });
    expect(String((await run()).error)).toMatch(/exportó a A3/);
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });

  it("rechazada entre la comprobación y la reserva: no reserva, sin hijas ni ficheros", async () => {
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, id);
    const pending = inFlight(run());
    // Comprobacion previa hecha, partes subidas y la reserva esperando la fila.
    await vi.waitFor(async () => {
      expect(splitKeys()).toHaveLength(2);
      expect(await sessionsWaitingForLock()).toBe(1);
    }, { timeout: 10_000 });
    await lock.release(`UPDATE "Invoice" SET status = 'REJECTED' WHERE id = $1`);
    const r = await pending;
    expect(String(r.error)).toMatch(/rechazada/);
    expect(await status()).toBe("REJECTED");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });

  it("validada mientras se preparaban las partes: no reserva con un estado de origen viejo", async () => {
    fakeS3().setMode("hold");
    const pending = inFlight(run());
    // Comprobacion previa hecha y descargando el PDF: se valida en ese momento.
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED" } });
    fakeS3().releaseGets();
    const r = await pending;
    expect(String(r.error)).toMatch(/ha cambiado/);
    expect(await status()).toBe("VALIDATED");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id } })).toBe(0);
  });

  it("una original VALIDATED que ya tiene hijas no se vuelve a dividir", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED" } });
    await makeInvoice(w.client, { status: "VALIDATED", splitFromId: id });
    expect((await run()).error).toBe("Esta factura ya se dividió: trabaja con las facturas que salieron de ella.");
    expect(await children()).toBe(1);
    expect(splitKeys()).toHaveLength(0);
  });

  it("le sale una hija entre la comprobación y la reserva: lo para la propia reserva", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "VALIDATED" } });
    // La division se para al leer los cierres de periodo, despues de las
    // comprobaciones previas y antes de subir las partes y reservar.
    const lock = await holdLock(`LOCK TABLE "PeriodClosure" IN ACCESS EXCLUSIVE MODE`);
    const pending = inFlight(run());
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    // La hija no toca la original: solo la condicion splitInvoices de la reserva puede pararla.
    await makeInvoice(w.client, { status: "VALIDATED", splitFromId: id });
    await lock.release();
    expect((await pending).error).toBe("Esta factura ya se dividió: trabaja con las facturas que salieron de ella.");
    expect(await status()).toBe("VALIDATED");
    expect(await children()).toBe(1);
    expect(splitKeys()).toHaveLength(0);
  });

  it("las hijas heredan typeUnconfirmed y periodType", async () => {
    await prisma.invoice.update({ where: { id }, data: { typeUnconfirmed: true, periodType: "QUARTERLY", periodMonth: 7 } });
    expect((await run()).error).toBeNull();
    const kids = await prisma.invoice.findMany({ where: { splitFromId: id } });
    expect(kids.map((k) => [k.typeUnconfirmed, k.periodType, k.periodMonth])).toEqual([[true, "QUARTERLY", 7], [true, "QUARTERLY", 7]]);
  });

  it.each([
    ["dañado", async () => Buffer.from("esto no es un pdf")],
    ["sin /Pages", async () => Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")],
    ["sin páginas", async () => blankPdf(0)],
  ])("PDF %s: { error } y no sube nada", async (_label, make) => {
    fakeS3().put("k-pdf", await make());
    expect((await run()).error).toBe("No se ha podido leer el PDF para dividirlo (¿está protegido o dañado?).");
    expect(await status()).toBe("PENDING_REVIEW");
    expect(splitKeys()).toHaveLength(0);
  });

  it("el gestor de otra asesoría no puede dividirla", async () => {
    const b = await makeFirm("B");
    signInAs(b.worker);
    expect((await run()).error).toBe("No tienes acceso a esta factura.");
    expect(await status()).toBe("PENDING_REVIEW");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });
});

describe("la fila de archivo de las partes (archivo, paso 5)", () => {
  const kids = (parentId: string) => prisma.invoice.findMany({
    where: { splitFromId: parentId },
    include: { archive: true },
    orderBy: { archive: { splitPart: "asc" } },
  });

  /** splitPart de todas las partes de la familia de la raíz, en orden. */
  async function familyParts(rootId: string): Promise<number[]> {
    const rows = await prisma.$queryRaw<{ splitPart: number }[]>`
      WITH RECURSIVE fam AS (
        SELECT "id" FROM "Invoice" WHERE "splitFromId" = ${rootId}
        UNION ALL
        SELECT c."id" FROM "Invoice" c JOIN fam ON c."splitFromId" = fam."id"
      )
      SELECT a."splitPart" FROM "InvoiceArchive" a JOIN fam ON fam."id" = a."invoiceId" ORDER BY 1`;
    return rows.map((r) => r.splitPart);
  }

  it("las hijas heredan llegada, tanda, posición, papel y medio, con splitPart 1..n y motivo split", async () => {
    const batch = await prisma.uploadBatch.create({
      data: { advisoryFirmId: w.firm.id, clientId: w.client.id, createdById: w.worker.id, fileCount: 9, periodYear: 2026, tacoNumber: 37 },
    });
    const receivedAt = new Date("2026-09-15T08:00:00.000Z");
    await prisma.invoiceArchive.update({
      where: { invoiceId: id },
      data: {
        receivedAt, uploadBatchId: batch.id, uploadPosition: 7, paperHeldByClient: true,
        originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco", pdfProducer: "Canon iR-ADV C5535",
      },
    });
    expect(await run()).toEqual({ error: null });
    const parts = await kids(id);
    expect(parts.map((p) => [p.filename, p.archive?.splitPart])).toEqual([["a.pdf", 1], ["b.pdf", 2]]);
    for (const part of parts) {
      expect(part.archive).toMatchObject({
        receivedAt, uploadBatchId: batch.id, uploadPosition: 7, paperHeldByClient: true,
        originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "split", pdfProducer: "Canon iR-ADV C5535",
      });
    }
    // La original se queda como estaba.
    expect(await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } }))
      .toMatchObject({ splitPart: 0, uploadPosition: 7, originalMediumReason: "taco" });
  });

  it("una parte que se vuelve a dividir no choca con sus hermanas: sigue desde el mayor de la familia", async () => {
    fakeS3().put("k-pdf", await blankPdf(4));
    const original = await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } });
    const halves = [{ name: "a", startPage: 1, endPage: 2 }, { name: "b", startPage: 3, endPage: 4 }];
    expect((await settle(splitPdfInvoice(id, halves, "all"))).error).toBeNull();
    const [a, b] = await kids(id);
    expect([a.archive?.splitPart, b.archive?.splitPart]).toEqual([1, 2]);

    await prisma.invoice.update({ where: { id: a.id }, data: { status: "PENDING_REVIEW" } });
    const pages = [{ name: "a1", startPage: 1, endPage: 1 }, { name: "a2", startPage: 2, endPage: 2 }];
    expect((await settle(splitPdfInvoice(a.id, pages, "all"))).error).toBeNull();
    const grandchildren = await kids(a.id);
    expect(grandchildren.map((g) => [g.filename, g.archive?.splitPart])).toEqual([["a1.pdf", 3], ["a2.pdf", 4]]);
    // La llegada sigue siendo la de la raíz.
    for (const g of grandchildren) expect(g.archive?.receivedAt).toEqual(original.receivedAt);
    expect(await familyParts(id)).toEqual([1, 2, 3, 4]);
  });

  it("dos hermanas que se dividen a la vez no repiten nº de parte (bloqueo de la fila de la raíz)", async () => {
    await prisma.invoice.update({ where: { id }, data: { status: "SPLIT_SOURCE" } });
    const sisters = [];
    for (const part of [1, 2]) {
      const sister = await makeInvoice(w.client, { storageKey: "k-pdf", splitFromId: id, status: "PENDING_REVIEW" });
      await prisma.invoiceArchive.update({ where: { invoiceId: sister.id }, data: { splitPart: part } });
      sisters.push(sister);
    }
    // Las dos divisiones se paran al crear el primer Document, ya dentro de su
    // transacción. Sin el bloqueo de la raíz, las dos habrían leído ya el mismo
    // máximo (2) y las dos darían 3 y 4.
    const lock = await holdLock(`LOCK TABLE "Document" IN ACCESS EXCLUSIVE MODE`);
    const pending = sisters.map((s) => inFlight(settle(splitPdfInvoice(s.id, parts, "all"))));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(2), { timeout: 20_000 });
    await lock.release();
    expect(await Promise.all(pending)).toEqual([{ error: null }, { error: null }]);
    expect(await familyParts(id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
