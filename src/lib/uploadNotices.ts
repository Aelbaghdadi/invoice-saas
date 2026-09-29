/**
 * Un solo aviso a los gestores por subida, no uno por fichero (F-040). La
 * pantalla de subida manda cada fichero en su propia petición: con 30 PDFs
 * salían 30 correos. Aquí se juntan las subidas del mismo cliente y periodo
 * y se avisa una vez cuando pasa UPLOAD_NOTICE_QUIET_MS sin ninguna nueva
 * (o, como mucho, UPLOAD_NOTICE_MAX_WAIT_MS después de la primera).
 *
 * En memoria del proceso: un redeploy con avisos pendientes los pierde (la
 * factura está igual en Lotes; el correo es solo un aviso).
 */

export const UPLOAD_NOTICE_QUIET_MS = 60_000;
export const UPLOAD_NOTICE_MAX_WAIT_MS = 5 * 60_000;

type Send = (count: number) => Promise<void>;
type Pending = { count: number; firstAt: number; timer: ReturnType<typeof setTimeout>; send: Send };

const globalForNotices = globalThis as unknown as { __facturocrUploadNotices?: Map<string, Pending> };
const pending: Map<string, Pending> = globalForNotices.__facturocrUploadNotices ??= new Map();

async function flush(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  try {
    await entry.send(entry.count);
  } catch (err) {
    console.error(`[NOTIFY] aviso de subida ${key}:`, err);
  }
}

/**
 * Apunta una subida. `send` recibe cuántas se han juntado; se usa el de la
 * primera subida del grupo (misma clave: mismo cliente y periodo).
 */
export function noteUpload(key: string, send: Send, now = Date.now()): void {
  const entry = pending.get(key);
  if (entry) {
    entry.count++;
    clearTimeout(entry.timer);
    const waitLeft = UPLOAD_NOTICE_MAX_WAIT_MS - (now - entry.firstAt);
    entry.timer = setTimeout(() => void flush(key), Math.max(0, Math.min(UPLOAD_NOTICE_QUIET_MS, waitLeft)));
    return;
  }
  pending.set(key, { count: 1, firstAt: now, send, timer: setTimeout(() => void flush(key), UPLOAD_NOTICE_QUIET_MS) });
}

/** Envía ya los avisos pendientes (tests). */
export async function flushUploadNotices(): Promise<void> {
  await Promise.all([...pending.keys()].map(flush));
}
