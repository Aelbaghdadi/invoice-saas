/**
 * Errores del servidor (F-034) desde instrumentation.ts (onRequestError):
 * una linea JSON en el log y, si hay ALERT_WEBHOOK_URL, un aviso por webhook
 * con un limite para no inundar. Sin SDK de terceros: el servicio de errores
 * (GlitchTip, Sentry…) esta por decidir y este webhook sirve de puente.
 *
 * Sin datos personales: la ruta va sin query (puede llevar nombres o
 * correos), no se mandan cabeceras ni cookies, y el mensaje se limpia de
 * correos, NIF/CIF/NIE, IBAN y numeros largos y se recorta.
 */

export type ErrorRequest = { path: string; method: string };
export type ErrorContext = { routePath?: string; routeType?: string };

export type ErrorReport = {
  level: "error";
  time: string;
  path: string;
  method: string;
  routePath: string | null;
  routeType: string | null;
  digest: string | null;
  name: string;
  message: string;
};

const MAX_MESSAGE = 300;

/** Quita del mensaje lo que puede ser un dato personal. */
export function scrubMessage(message: string): string {
  return message
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{2}\d{2}[ ]?(?:\d{4}[ ]?){4,7}\d{0,4}\b/g, "[iban]")
    .replace(/\b(?:[XYZ]\d{7}|\d{8}|[ABCDEFGHJNPQRSUVW]\d{7})[A-Z0-9]\b/gi, "[nif]")
    .replace(/\d{9,}/g, "[num]")
    .slice(0, MAX_MESSAGE);
}

export function buildErrorReport(error: unknown, request: ErrorRequest, context: ErrorContext, now = new Date()): ErrorReport {
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = (error as { digest?: unknown } | null)?.digest;
  return {
    level: "error",
    time: now.toISOString(),
    path: request.path.split("?")[0],
    method: request.method,
    routePath: context.routePath ?? null,
    routeType: context.routeType ?? null,
    digest: typeof digest === "string" ? digest : null,
    name: err.name,
    message: scrubMessage(err.message),
  };
}

/**
 * Como mucho `max` avisos por ventana de `windowMs`. Los que no pasan se
 * cuentan y se dicen en el siguiente que pase.
 */
export function createAlertLimiter(max: number, windowMs: number) {
  let windowStart = 0;
  let sent = 0;
  let suppressed = 0;
  return {
    /** null si no toca avisar; si toca, cuantos se callaron antes. */
    take(now: number): { suppressedBefore: number } | null {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        sent = 0;
      }
      if (sent >= max) {
        suppressed++;
        return null;
      }
      sent++;
      const suppressedBefore = suppressed;
      suppressed = 0;
      return { suppressedBefore };
    },
  };
}

// Por proceso: 10 avisos cada 5 minutos.
const limiter = createAlertLimiter(10, 5 * 60_000);

type Deps = {
  webhookUrl?: string;
  log?: (line: string) => void;
  fetchFn?: typeof fetch;
  limiter?: ReturnType<typeof createAlertLimiter>;
  now?: Date;
};

export async function reportRequestError(error: unknown, request: ErrorRequest, context: ErrorContext, deps: Deps = {}): Promise<void> {
  const report = buildErrorReport(error, request, context, deps.now);
  (deps.log ?? console.error)(JSON.stringify(report));

  const webhookUrl = deps.webhookUrl ?? process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;
  const allowed = (deps.limiter ?? limiter).take((deps.now ?? new Date()).getTime());
  if (!allowed) return;
  const extra = allowed.suppressedBefore > 0 ? ` (+${allowed.suppressedBefore} errores sin avisar por el límite)` : "";
  const text = `Error en FacturOCR: ${report.method} ${report.path} — ${report.name}: ${report.message}${report.digest ? ` [${report.digest}]` : ""}${extra}`;
  try {
    // `text` para Slack/Mattermost, `content` para Discord; el resto, para
    // quien lo quiera procesar.
    await (deps.fetchFn ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, ...report, suppressedBefore: allowed.suppressedBefore }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    // Si el webhook falla, no se reintenta ni se lanza: el error ya esta en el log.
    console.warn(`[alert] no se pudo avisar por webhook: ${err instanceof Error ? err.name : "Error"}`);
  }
}
