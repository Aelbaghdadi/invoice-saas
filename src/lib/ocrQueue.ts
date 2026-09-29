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

type OcrQueue = { semaphore: Semaphore; waiting: Map<string, symbol>; stopping: boolean };

// En globalThis: en desarrollo el recargado de modulos creaba otra cola.
const globalForQueue = globalThis as unknown as { __facturocrOcrQueue?: OcrQueue };
const queue: OcrQueue = globalForQueue.__facturocrOcrQueue ??= {
  semaphore: new Semaphore(ocrConcurrencyFromEnv(process.env.OCR_CONCURRENCY)),
  waiting: new Map(),
  stopping: false,
};

/**
 * Corre `task` cuando haya hueco. Si la factura ya espera en la cola, no se
 * encola otra vez; con `priority` (un «Reprocesar» a mano) pasa delante de
 * las demás, y si ya esperaba, se adelanta.
 */
export async function runQueuedOcr(invoiceId: string, task: () => Promise<void>, options: { priority?: boolean } = {}): Promise<void> {
  // Parando el proceso: lo que no ha empezado se queda en UPLOADED, sin
  // gastar intento, y lo relanza retry-stuck tras el redeploy.
  if (queue.stopping) return;
  if (queue.waiting.has(invoiceId)) {
    if (options.priority) queue.semaphore.promote(invoiceId);
    return;
  }
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
      if (queue.stopping) return Promise.resolve();
      return task();
    }, { key: invoiceId, priority: options.priority });
  } finally {
    leaveQueue();
  }
}

/** Cuantas esperan delante de esta factura en la cola de este proceso, o
 *  null si no esta esperando aqui (la revision lo dice en el aviso). */
export function ocrQueuePosition(invoiceId: string): number | null {
  return queue.waiting.has(invoiceId) ? queue.semaphore.position(invoiceId) : null;
}

/** Cuantas corren y cuantas esperan (para los tests). */
export function ocrQueueState(): { active: number; waiting: number } {
  return { active: queue.semaphore.active, waiting: queue.semaphore.waiting };
}

/**
 * Deja de arrancar analisis (revision 1 del PR #14, punto 6). Con SIGTERM,
 * Next espera a los after() en curso durante el periodo de gracia: los que
 * ya analizan terminan; los que esperan en la cola salen sin empezar (siguen
 * en UPLOADED y sin gastar intento) en vez de empezar un OCR que el SIGKILL
 * cortaria a medias.
 */
export function stopStartingOcr(stopping = true): void {
  queue.stopping = stopping;
}

/** Desde instrumentation.ts, al arrancar el servidor. */
export function stopStartingOcrOnShutdown(): void {
  const onSigterm = () => {
    stopStartingOcr();
    // Si no hay nadie mas escuchando (fuera de next start), que SIGTERM
    // haga lo de siempre: con un listener, Node ya no sale solo.
    if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
  };
  process.once("SIGTERM", onSigterm);
}

/** Solo para tests: cambiar el limite sin reiniciar el proceso. */
export function setOcrConcurrency(limit: number): void {
  queue.semaphore.setLimit(limit);
}
