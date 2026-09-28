/**
 * Esperas entre reintentos del OCR (F-029): exponencial con jitter y, si el
 * proveedor dice cuanto esperar (Retry-After en 429 y 503), eso, con un tope.
 * Antes eran 1,2 y 2,4 s fijos: con una subida grande, todas las facturas
 * reintentaban a la vez contra un proveedor que ya estaba limitando.
 */

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** Un Retry-After mayor no se espera entero: la factura sigue en ANALYZING
 *  y el cron la da por atascada a los 5 minutos. Con 4 intentos de 30 s como
 *  mucho y 3 esperas de 30 s, el peor caso son 3,5 minutos. */
export const RETRY_AFTER_MAX_MS = 30_000;

/**
 * Retry-After en milisegundos: en segundos («120») o en fecha HTTP
 * («Wed, 21 Oct 2026 07:28:00 GMT»). null si no viene o no se entiende.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header == null) return null;
  const value = header.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Una fecha HTTP lleva el dia y el mes en letras; Date.parse da por
  // buena cualquier cosa («-5» es el año 5 antes de Cristo).
  if (!/[a-z]/i.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * La espera que piden las APIs de Google en el cuerpo del error, no en la
 * cabecera (revision 1 del PR #14, punto 5): `error.details[]` con
 * `"@type": "type.googleapis.com/google.rpc.RetryInfo"` y
 * `"retryDelay": "37s"`. null si no viene o no se entiende.
 */
export function retryDelayFromGoogleBody(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const details = (parsed as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    const d = detail as { "@type"?: unknown; retryDelay?: unknown } | null;
    if (typeof d?.["@type"] !== "string" || !d["@type"].endsWith("google.rpc.RetryInfo")) continue;
    const match = typeof d.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim()) : null;
    if (match) return Math.round(Number(match[1]) * 1000);
  }
  return null;
}

/**
 * Cuanto esperar antes del intento `attempt + 1` (attempt empieza en 1).
 * Sin Retry-After: «full jitter» sobre 1 s, 2 s, 4 s… hasta 30 s, para que
 * las facturas de una misma subida no reintenten todas a la vez.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null = null, random: () => number = Math.random): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, RETRY_AFTER_MAX_MS);
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
