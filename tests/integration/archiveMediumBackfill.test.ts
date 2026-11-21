// Detección de electrónico o papel de los PDF de antes del archivo (anexo C3):
// la función y su ruta cron, con PDF de verdad en el S3 falso.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Invoice } from "@prisma/client";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { inFlight } from "./helpers/inflight";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { signInAs } from "./helpers/session";
import { DIGITAL_PRODUCER, digitalPdf, imageOnlyPdf, SCANNER_PRODUCER, scannerPdf, testPdf } from "./helpers/pdfs";
import { ARCHIVE_MEDIUM_BACKFILL_WAITS, runArchiveMediumBackfill } from "@/lib/archiveMediumBackfill";
import { GET as detect, POST as detectPost } from "@/app/api/cron/archivo-detectar/route";
import { splitPdfInvoice } from "@/app/dashboard/worker/review/[id]/actions";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

let sequence = 0;
/** Un PDF de antes del archivo: como lo deja el relleno de la migración 12. */
async function legacyPdf(world: FirmWorld, body: Buffer | string | null, extra: Partial<Invoice> = {}): Promise<Invoice> {
  const key = `${world.client.id}/2025-11/antiguo-${++sequence}.pdf`;
  if (body != null) fakeS3().put(key, body);
  const invoice = await makeInvoice(world.client, { storageKey: key, status: "VALIDATED", ...extra });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: { originalMediumSource: "AUTO", originalMediumReason: "backfill_pending" },
  });
  return invoice;
}

const archive = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({
  where: { invoiceId },
  select: { originalMedium: true, originalMediumSource: true, originalMediumReason: true, pdfProducer: true },
});
const cronRequest = (query = "", secret = "cron-test") =>
  new Request(`http://x/api/cron/archivo-detectar${query}`, { headers: { authorization: `Bearer ${secret}` } });

describe("detección de los PDF antiguos (anexo C3)", () => {
  it("cada PDF pendiente, como al analizar; de cualquier asesoría, sin auditoría y sin tocar lo demás", async () => {
    const digital = await legacyPdf(a, await digitalPdf());
    const scanner = await legacyPdf(a, await scannerPdf());
    const photoPdf = await legacyPdf(b, await imageOnlyPdf());
    const broken = await legacyPdf(b, "%PDF-1.4 roto");
    const missing = await legacyPdf(b, null);
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: digital.id } });

    expect(await runArchiveMediumBackfill()).toEqual({ revisadas: 5, electronicas: 1, porConfirmar: 2, ilegibles: 2, errores: 0, quedan: 0 });
    expect(await archive(digital.id)).toEqual({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: DIGITAL_PRODUCER });
    expect(await archive(scanner.id)).toEqual({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed", pdfProducer: SCANNER_PRODUCER });
    expect(await archive(photoPdf.id)).toMatchObject({ originalMedium: null, originalMediumReason: "scan_unconfirmed" });
    expect(await archive(broken.id)).toMatchObject({ originalMedium: null, originalMediumReason: "pdf_unreadable" });
    expect(await archive(missing.id)).toMatchObject({ originalMedium: null, originalMediumReason: "pdf_unreadable" });
    expect(await prisma.auditLog.count()).toBe(0);
    // La factura no cambia (ni su updatedAt, el testigo de la revisión).
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: digital.id } })).toEqual(before);
  });

  it("solo toca lo pendiente: ni lo ya analizado ni lo puesto a mano", async () => {
    const analyzed = await legacyPdf(a, await scannerPdf());
    await prisma.invoiceArchive.update({ where: { invoiceId: analyzed.id }, data: { originalMediumReason: "pdf_text", originalMedium: "ELECTRONIC" } });
    const manual = await legacyPdf(a, await digitalPdf());
    await prisma.invoiceArchive.update({ where: { invoiceId: manual.id }, data: { originalMediumSource: "MANUAL", originalMedium: "PAPER" } });
    const gets = fakeS3().getCount();

    expect(await runArchiveMediumBackfill()).toMatchObject({ revisadas: 0, quedan: 0 });
    expect(fakeS3().getCount()).toBe(gets);
    expect(await archive(analyzed.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
    expect(await archive(manual.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "backfill_pending" });
  });

  it("es idempotente y va por tandas: limit y lo que queda", async () => {
    for (let i = 0; i < 3; i++) await legacyPdf(a, await digitalPdf());
    expect(await runArchiveMediumBackfill({ limit: 2 })).toMatchObject({ revisadas: 2, electronicas: 2, quedan: 1 });
    expect(await runArchiveMediumBackfill({ limit: 2 })).toMatchObject({ revisadas: 1, electronicas: 1, quedan: 0 });
    const after = await prisma.invoiceArchive.findMany({ orderBy: { invoiceId: "asc" } });
    expect(await runArchiveMediumBackfill()).toEqual({ revisadas: 0, electronicas: 0, porConfirmar: 0, ilegibles: 0, errores: 0, quedan: 0 });
    expect(await prisma.invoiceArchive.findMany({ orderBy: { invoiceId: "asc" } })).toEqual(after);
  });

  it("una original dividida: mira su PDF y la propuesta llega a sus partes (anexo C18)", async () => {
    const root = await legacyPdf(a, await digitalPdf(), { status: "SPLIT_SOURCE" });
    const parts: Invoice[] = [];
    for (const n of [1, 2]) {
      // Cada parte tiene su propio PDF, hecho por la app al dividir: no se mira.
      const part = await makeInvoice(a.client, { splitFromId: root.id, storageKey: `${a.client.id}/parte-${n}.pdf` });
      fakeS3().put(part.storageKey, await scannerPdf());
      await prisma.invoiceArchive.update({
        where: { invoiceId: part.id },
        data: { originalMediumSource: "AUTO", originalMediumReason: "split", splitPart: n },
      });
      parts.push(part);
    }
    expect(await runArchiveMediumBackfill()).toMatchObject({ revisadas: 1, electronicas: 1, quedan: 0 });
    expect(await archive(root.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text", pdfProducer: DIGITAL_PRODUCER });
    for (const part of parts) {
      expect(await archive(part.id)).toEqual({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "split", pdfProducer: DIGITAL_PRODUCER });
    }
  });

  it("si mientras se descarga alguien decide el medio, no lo pisa", async () => {
    const invoice = await legacyPdf(a, await digitalPdf());
    fakeS3().setMode("hold");
    const run = inFlight(runArchiveMediumBackfill());
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" },
    });
    fakeS3().releaseGets();
    expect(await run).toMatchObject({ revisadas: 1, electronicas: 0, quedan: 0 });
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" });
  });

  it("si mientras se descarga el análisis ya la resolvió (sigue AUTO, pero ya no pendiente), no la pisa con lo que lea", async () => {
    const invoice = await legacyPdf(a, await digitalPdf());
    fakeS3().setMode("hold");
    const run = inFlight(runArchiveMediumBackfill());
    await vi.waitFor(() => expect(fakeS3().heldGets()).toBe(1));
    // Un reproceso la deja como la deja el análisis, y la lectura de la
    // detección sale rota: escribir solo con AUTO dejaría «No se pudo leer».
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: DIGITAL_PRODUCER },
    });
    fakeS3().put(invoice.storageKey, "%PDF-1.4 roto");
    fakeS3().releaseGets();
    expect(await run).toMatchObject({ revisadas: 1, electronicas: 0, ilegibles: 0, quedan: 0 });
    expect(await archive(invoice.id)).toEqual({
      originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: DIGITAL_PRODUCER,
    });
  });

  it("si el almacenamiento falla, la deja pendiente para la siguiente llamada", async () => {
    const invoice = await legacyPdf(a, await digitalPdf());
    fakeS3().setMode("down");
    expect(await runArchiveMediumBackfill()).toMatchObject({ revisadas: 1, errores: 1, quedan: 1 });
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumReason: "backfill_pending" });
    fakeS3().setMode("ok");
    expect(await runArchiveMediumBackfill()).toMatchObject({ revisadas: 1, electronicas: 1, errores: 0, quedan: 0 });
  });
});

describe("una fila que falla no para la detección", () => {
  const POISON = "test_archivo_fila_envenenada";
  const LOCK_TIMEOUT_MS = ARCHIVE_MEDIUM_BACKFILL_WAITS.lockTimeoutMs;
  afterEach(async () => {
    ARCHIVE_MEDIUM_BACKFILL_WAITS.lockTimeoutMs = LOCK_TIMEOUT_MS;
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${POISON} ON "InvoiceArchive"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${POISON}()`);
  });

  /** Tres PDF digitales pendientes, en el orden en que los toma la detección. */
  async function threePending(): Promise<Invoice[]> {
    const rows: Invoice[] = [];
    for (let i = 0; i < 3; i++) rows.push(await legacyPdf(a, await digitalPdf()));
    return rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  /** Un trigger temporal que hace fallar el UPDATE de la fila de archivo de esa factura. */
  async function poison(invoiceId: string, sqlstate: string, condition = "true") {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${POISON}() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fila envenenada' USING ERRCODE = '${sqlstate}'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${POISON} BEFORE UPDATE ON "InvoiceArchive" FOR EACH ROW
      WHEN (OLD."invoiceId" = '${invoiceId}' AND ${condition}) EXECUTE FUNCTION ${POISON}()`);
  }

  const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return await work();
    } finally {
      quiet.mockRestore();
    }
  };

  it("un NUL en el productor del PDF: se detecta igual, con el productor limpio, y las de detrás también", async () => {
    const [first, middle, last] = await threePending();
    fakeS3().put(middle.storageKey, await testPdf({ text: true, producer: "Acme\u0000PDF" }));
    expect(await runArchiveMediumBackfill()).toEqual({ revisadas: 3, electronicas: 3, porConfirmar: 0, ilegibles: 0, errores: 0, quedan: 0 });
    expect(await archive(middle.id)).toEqual({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text", pdfProducer: "Acme PDF" });
    for (const row of [first, last]) expect(await archive(row.id)).toMatchObject({ originalMedium: "ELECTRONIC", pdfProducer: DIGITAL_PRODUCER });
  });

  it("un error que se repite siempre en una fila: va a errores, siguen las de detrás y la ruta responde 200", async () => {
    const [first, middle, last] = await threePending();
    await poison(middle.id, "P0001");
    await quietly(async () => {
      const calls = [
        { revisadas: 3, electronicas: 2, porConfirmar: 0, ilegibles: 0, errores: 1, quedan: 1 },
        { revisadas: 1, electronicas: 0, porConfirmar: 0, ilegibles: 0, errores: 1, quedan: 1 },
      ];
      for (const expected of calls) {
        const res = await detect(cronRequest());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(expected);
      }
    });
    for (const row of [first, last]) expect(await archive(row.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
    expect(await archive(middle.id)).toMatchObject({ originalMedium: null, originalMediumReason: "backfill_pending" });
  });

  it("un error de datos (22xxx) al guardar lo leído: «No se pudo leer el PDF» sin productor, para que no quede pendiente para siempre", async () => {
    const [first, middle, last] = await threePending();
    // Falla solo si se guarda un productor, como el NUL que Postgres no admite.
    await poison(middle.id, "22021", `NEW."pdfProducer" IS NOT NULL`);
    expect(await quietly(() => runArchiveMediumBackfill())).toEqual({
      revisadas: 3, electronicas: 2, porConfirmar: 0, ilegibles: 1, errores: 0, quedan: 0,
    });
    expect(await archive(middle.id)).toEqual({ originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "pdf_unreadable", pdfProducer: null });
    for (const row of [first, last]) expect(await archive(row.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
  });

  it("una fila que otra transacción retiene más del lock_timeout: va a errores sin tumbar la llamada y la siguiente la retoma", async () => {
    ARCHIVE_MEDIUM_BACKFILL_WAITS.lockTimeoutMs = 300;
    const [first] = await threePending();
    const lock = await holdLock(`SELECT 1 FROM "InvoiceArchive" WHERE "invoiceId" = $1 FOR UPDATE`, first.id);
    const started = Date.now();
    const detection = inFlight(runArchiveMediumBackfill());
    // Como un export grande: suelta la fila a los 6 s. Sin lock_timeout se
    // esperaba a que la soltara y, pasados los 5 s de la transacción, P2028.
    await Promise.race([detection.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 6_000))]);
    await lock.release();
    expect(await detection).toEqual({ revisadas: 3, electronicas: 2, porConfirmar: 0, ilegibles: 0, errores: 1, quedan: 1 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await runArchiveMediumBackfill()).toEqual({ revisadas: 1, electronicas: 1, porConfirmar: 0, ilegibles: 0, errores: 0, quedan: 0 });
  });
});

describe("con una división a la vez (anexo C14 y C18)", () => {
  const halves = [{ name: "a", startPage: 1, endPage: 1 }, { name: "b", startPage: 2, endPage: 2 }];
  const settle = (p: Promise<{ error?: string } | void>) => p.then(
    (r) => ({ error: r?.error ?? null }),
    (e) => (e?.message === "NEXT_REDIRECT" ? { error: null } : Promise.reject(e)),
  );

  /**
   * Para la división al crear su primer Document (ya tiene la fila de archivo
   * de la raíz bloqueada), lanza la detección y deja seguir a la división
   * cuando las dos esperan. Devuelve lo que responde la detección.
   */
  async function detectDuringSplit(invoiceId: string) {
    signInAs(a.worker);
    const lock = await holdLock(`LOCK TABLE "Document" IN ACCESS EXCLUSIVE MODE`);
    const split = inFlight(settle(splitPdfInvoice(invoiceId, halves, "all")));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 20_000 });
    const detection = inFlight(runArchiveMediumBackfill());
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(2), { timeout: 20_000 });
    await lock.release();
    expect(await split).toEqual({ error: null });
    return detection;
  }

  const electronicPart = { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "split", pdfProducer: DIGITAL_PRODUCER };

  it("la original que se divide mientras se detecta: sus partes nuevas también quedan electrónicas", async () => {
    const root = await legacyPdf(a, await testPdf({ text: true, producer: DIGITAL_PRODUCER, pages: 2 }), { status: "PENDING_REVIEW" });
    expect(await detectDuringSplit(root.id)).toMatchObject({ revisadas: 1, electronicas: 1, errores: 0, quedan: 0 });
    expect(await archive(root.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumReason: "pdf_text" });
    const parts = await prisma.invoice.findMany({ where: { splitFromId: root.id }, select: { id: true } });
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(await archive(part.id)).toEqual(electronicPart);
  });

  it("una parte que se vuelve a dividir mientras se detecta su raíz: las nietas también (toda la familia a la vez)", async () => {
    const root = await legacyPdf(a, await digitalPdf(), { status: "SPLIT_SOURCE" });
    const parts: Invoice[] = [];
    for (const n of [1, 2]) {
      const part = await makeInvoice(a.client, { splitFromId: root.id, storageKey: `${a.client.id}/parte-${n}.pdf`, status: "PENDING_REVIEW" });
      fakeS3().put(part.storageKey, await testPdf({ text: true, pages: 2 }));
      await prisma.invoiceArchive.update({
        where: { invoiceId: part.id },
        data: { originalMediumSource: "AUTO", originalMediumReason: "split", splitPart: n },
      });
      parts.push(part);
    }
    expect(await detectDuringSplit(parts[0].id)).toMatchObject({ revisadas: 1, electronicas: 1, errores: 0, quedan: 0 });
    const grandchildren = await prisma.invoice.findMany({ where: { splitFromId: parts[0].id }, select: { id: true } });
    expect(grandchildren).toHaveLength(2);
    for (const member of [...parts, ...grandchildren]) expect(await archive(member.id)).toEqual(electronicPart);
  });
});

describe("/api/cron/archivo-detectar", () => {
  it("sin el secreto, 401; con él, GET y POST", async () => {
    await legacyPdf(a, await digitalPdf());
    expect((await detect(cronRequest("", "otro"))).status).toBe(401);
    expect((await detect(new Request("http://x/api/cron/archivo-detectar"))).status).toBe(401);
    const res = await detectPost(new Request("http://x/api/cron/archivo-detectar", { method: "POST", headers: { authorization: "Bearer cron-test" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revisadas: 1, electronicas: 1, porConfirmar: 0, ilegibles: 0, errores: 0, quedan: 0 });
  });

  it("?dryRun=1 solo cuenta lo pendiente: ni descarga ni escribe", async () => {
    const invoice = await legacyPdf(a, await digitalPdf());
    await legacyPdf(b, await scannerPdf());
    const gets = fakeS3().getCount();
    const res = await detect(cronRequest("?dryRun=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, quedan: 2 });
    expect(fakeS3().getCount()).toBe(gets);
    expect(await archive(invoice.id)).toMatchObject({ originalMedium: null, originalMediumReason: "backfill_pending" });
  });

  it("?limit= de 1 a 200 (50 por defecto); fuera de rango, 400 sin tocar nada", async () => {
    for (let i = 0; i < 3; i++) await legacyPdf(a, await digitalPdf());
    for (const bad of ["?limit=0", "?limit=201", "?limit=dos", "?dryRun=si"]) {
      const res = await detect(cronRequest(bad));
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error, bad).toMatch(/^Parámetros no válidos/);
    }
    expect(await (await detect(cronRequest("?limit=2"))).json()).toMatchObject({ revisadas: 2, quedan: 1 });
    expect(await (await detect(cronRequest())).json()).toMatchObject({ revisadas: 1, quedan: 0 });
  });
});
