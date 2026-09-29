/**
 * Ritmo de los refrescos automáticos (Lotes con OCR en marcha, el aviso de
 * «Analizando…» en la revisión) (F-081). Antes: router.refresh() cada 3 o
 * 5 s, sin fin, también con la pestaña en segundo plano.
 *
 * - Empieza a REFRESH_MIN_MS y cada refresco sin cambios espera más, hasta
 *   REFRESH_MAX_MS.
 * - Un cambio en lo que se ve vuelve al ritmo inicial.
 * - Tras REFRESH_IDLE_STOP_MS sin cambios, para. Al volver a la pestaña
 *   arranca otra vez.
 */

export const REFRESH_MIN_MS = 5_000;
export const REFRESH_MAX_MS = 60_000;
export const REFRESH_GROWTH = 1.5;
export const REFRESH_IDLE_STOP_MS = 10 * 60_000;

/** La espera siguiente: la primera, REFRESH_MIN_MS; luego, ×1,5 hasta el tope. */
export function nextRefreshDelay(previous: number | null, minMs = REFRESH_MIN_MS): number {
  if (previous == null) return minMs;
  return Math.min(REFRESH_MAX_MS, Math.round(previous * REFRESH_GROWTH));
}

/** ¿Hay que dejar de refrescar? Tras 10 minutos sin cambios. */
export function refreshIdleExpired(lastChangeAt: number, now: number): boolean {
  return now - lastChangeAt >= REFRESH_IDLE_STOP_MS;
}
