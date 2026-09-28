import { Semaphore } from "@/lib/semaphore";

/**
 * Cola del OCR en este proceso (F-029). Cada fichero subido lanza su
 * processInvoice en un after(): una subida de 200 PDFs eran 200 llamadas a
 * Gemini a la vez, y el proveedor respondia con 429 a casi todas.
 *
 * - Como mucho OCR_CONCURRENCY analisis a la vez (4 por defecto). Lo que
 *   espera sigue en UPLOADED: el hueco se pide antes del claim, asi que la
 *   valla del OCR (ocrAttempts) no cambia.
 * - La cola vive en memoria: un redeploy la pierde, y lo que quede en
 *   UPLOADED lo relanza el cron retry-stuck (a los 5 minutos).
 * - Una factura que ya espera en la cola no se encola otra vez (el cron la ve
 *   en UPLOADED mientras espera): la segunda llamada vuelve sin hacer nada.
 *   Una que ya se esta analizando si se puede relanzar: si el cron la ha
 *   devuelto a UPLOADED es porque se ha colgado, y la valla (ocrAttempts)
 *   impide que la colgada pise a la nueva.
 */

export const DEFAULT_OCR_CONCURRENCY = 4;

export function ocrConcurrencyFromEnv(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : DEFAULT_OCR_CONCURRENCY;
}

type OcrQueue = { semaphore: Semaphore; waiting: Map<string, symbol> };

// En globalThis: en desarrollo el recargado de modulos creaba otra cola.
const globalForQueue = globalThis as unknown as { __facturocrOcrQueue?: OcrQueue };
const queue: OcrQueue = globalForQueue.__facturocrOcrQueue ??= {
  semaphore: new Semaphore(ocrConcurrencyFromEnv(process.env.OCR_CONCURRENCY)),
  waiting: new Map(),
};

/** Corre `task` cuando haya hueco. Si la factura ya espera en la cola, nada. */
export async function runQueuedOcr(invoiceId: string, task: () => Promise<void>): Promise<void> {
  if (queue.waiting.has(invoiceId)) return;
  // Con su ficha: al terminar, una ejecucion no borra la espera de otra
  // posterior de la misma factura.
  const ticket = Symbol(invoiceId);
  queue.waiting.set(invoiceId, ticket);
  const leaveQueue = () => {
    if (queue.waiting.get(invoiceId) === ticket) queue.waiting.delete(invoiceId);
  };
  try {
    await queue.semaphore.run(() => {
      leaveQueue();
      return task();
    });
  } finally {
    leaveQueue();
  }
}

/** Cuantas corren y cuantas esperan (para los tests). */
export function ocrQueueState(): { active: number; waiting: number } {
  return { active: queue.semaphore.active, waiting: queue.semaphore.waiting };
}

/** Solo para tests: cambiar el limite sin reiniciar el proceso. */
export function setOcrConcurrency(limit: number): void {
  queue.semaphore.setLimit(limit);
}
