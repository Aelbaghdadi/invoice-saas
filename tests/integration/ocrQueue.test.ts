// F-029: el OCR con límite de concurrencia y reintentos que respetan
// Retry-After, contra Postgres y con el OCR simulado.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { stubOcr } from "./helpers/ocr";
import { fakeS3 } from "./helpers/fakeS3";
import { processInvoice, OCR_WAITS } from "@/lib/processInvoice";
import { ocrQueueState, setOcrConcurrency, DEFAULT_OCR_CONCURRENCY } from "@/lib/ocrQueue";
import { OcrHttpError } from "@/lib/ocrErrors";
import type { ExtractedInvoice, OcrResult } from "@/lib/ocr";

let w: FirmWorld;
const reply = (n: number): OcrResult => ({
  rawJson: "{}",
  extracted: {
    issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: w.client.name, receiverCif: w.client.cif,
    invoiceNumber: `Q-${n}`, invoiceDate: "2026-09-10", taxBase: 100, vatRate: 21, vatAmount: 21,
    irpfRate: null, irpfAmount: null, totalAmount: 121 + n, currency: "EUR", supplyType: null,
    vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
  } as ExtractedInvoice,
});
const upload = async (n: number) => {
  fakeS3().put(`k-q${n}`, "%PDF-1.4");
  return (await makeInvoice(w.client, {
    filename: `q${n}.pdf`, storageKey: `k-q${n}`, fileType: "application/pdf", status: "UPLOADED",
    invoiceNumber: null, totalAmount: null,
  })).id;
};

const countByStatus = async (ids: string[]) => Object.fromEntries(
  (await prisma.invoice.groupBy({ by: ["status"], where: { id: { in: ids } }, _count: true })).map((g) => [g.status, g._count]),
);
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("no llegó a tiempo");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  w = await makeFirm("A");
});
afterEach(() => {
  setOcrConcurrency(DEFAULT_OCR_CONCURRENCY);
});

describe("cola del OCR (F-029)", () => {
  it("10 a la vez con límite 2: terminan todas y nunca hay más de 2 en el OCR", async () => {
    setOcrConcurrency(2);
    let inOcr = 0;
    let maxInOcr = 0;
    let calls = 0;
    const firstReply = async () => {
      const n = ++calls;
      inOcr++;
      maxInOcr = Math.max(maxInOcr, inOcr);
      await new Promise((r) => setTimeout(r, 30));
      inOcr--;
      return reply(n);
    };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await upload(i));

    // El OCR simulado se queda parado hasta que se mire el estado a mitad.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    stubOcr(async () => { await gate; return firstReply(); });
    const running = Promise.all(ids.map((id) => processInvoice(id, w.worker.id)));
    try {
      // Mientras esperan en la cola siguen en UPLOADED; solo 2 pasan a ANALYZING.
      await waitFor(async () => (await countByStatus(ids)).ANALYZING === 2);
      expect(ocrQueueState()).toEqual({ active: 2, waiting: 8 });
      expect(await countByStatus(ids)).toEqual({ ANALYZING: 2, UPLOADED: 8 });
    } finally {
      stubOcr(firstReply);
      open();
      // Siempre se espera: si no, el reset de la BD del test siguiente
      // chocaba con los análisis que seguían en marcha.
      await running;
    }
    expect(maxInOcr).toBe(2);
    expect(calls).toBe(10);
    const after = await prisma.invoice.findMany({ where: { id: { in: ids } }, select: { status: true, ocrAttempts: true } });
    expect(after.every((i) => i.status !== "UPLOADED" && i.status !== "ANALYZING")).toBe(true);
    expect(after.every((i) => i.ocrAttempts === 1)).toBe(true);
    expect(ocrQueueState()).toEqual({ active: 0, waiting: 0 });
  });

  it("la misma factura dos veces mientras espera (el cron la ve en UPLOADED): se encola una vez", async () => {
    setOcrConcurrency(1);
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let calls = 0;
    stubOcr(async () => { calls++; await gate; return reply(calls); });
    const first = await upload(1);
    const second = await upload(2);
    const running = [processInvoice(first, w.worker.id), processInvoice(second, w.worker.id), processInvoice(second, w.worker.id)];
    try {
      await waitFor(async () => calls === 1);
      // La segunda llamada con la misma factura vuelve sin ocupar sitio.
      expect(ocrQueueState()).toEqual({ active: 1, waiting: 1 });
    } finally {
      open();
      await Promise.all(running);
    }
    expect(calls).toBe(2);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: second } })).ocrAttempts).toBe(1);
  });

  it("un error del OCR libera el hueco", async () => {
    setOcrConcurrency(1);
    stubOcr(async () => { throw new Error("archivo corrupto"); });
    const bad = await upload(1);
    await processInvoice(bad, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: bad } })).status).toBe("OCR_ERROR");
    stubOcr(async () => reply(2));
    const good = await upload(2);
    await processInvoice(good, w.worker.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: good } })).status).not.toBe("UPLOADED");
    expect(ocrQueueState()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("S3 colgado (revisión 1 del PR #14, punto 1)", () => {
  it("la descarga tiene tope: la factura acaba en OCR_ERROR y el hueco se libera", async () => {
    const original = OCR_WAITS.storageMs;
    OCR_WAITS.storageMs = 150;
    setOcrConcurrency(1);
    stubOcr(async () => reply(1));
    try {
      const id = await upload(1);
      fakeS3().setMode("hold");
      await processInvoice(id, w.worker.id);
      const row = await prisma.invoice.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("OCR_ERROR");
      // El corte cuenta como transitorio: se reintenta hasta agotar los intentos.
      expect(fakeS3().heldGets()).toBe(4);
      expect(ocrQueueState()).toEqual({ active: 0, waiting: 0 });
      // Con el hueco libre, la siguiente se analiza.
      fakeS3().setMode("ok");
      fakeS3().releaseGets({ fail: true });
      const next = await upload(2);
      await processInvoice(next, w.worker.id);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: next } })).status).not.toBe("OCR_ERROR");
    } finally {
      OCR_WAITS.storageMs = original;
    }
  }, 30_000);
});

describe("reintentos del OCR (F-029)", () => {
  it("un 429 con Retry-After espera lo que pide y reintenta", async () => {
    let calls = 0;
    const at: number[] = [];
    stubOcr(async () => {
      at.push(Date.now());
      if (++calls === 1) throw new OcrHttpError("Gemini Flash respondió 429: Too Many Requests", 429, 300);
      return reply(1);
    });
    const id = await upload(1);
    await processInvoice(id, w.worker.id);
    expect(calls).toBe(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(290);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).not.toBe("OCR_ERROR");
  });

  it("un error que no es transitorio no se reintenta", async () => {
    let calls = 0;
    stubOcr(async () => { calls++; throw new OcrHttpError("Gemini Flash respondió 400: invalid argument", 400, null); });
    const id = await upload(1);
    await processInvoice(id, w.worker.id);
    expect(calls).toBe(1);
  });
});
