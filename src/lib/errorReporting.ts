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

/**
 * Quita del mensaje lo que puede ser un dato personal. Primero todo lo
 * entrecomillado: un PrismaClientValidationError vuelca los argumentos
 * (`issuerName: "Ana Pérez García"`, `issuerCif: "ESB12345674"`). Despues,
 * lo que quede suelto: correos, IBAN, NIF/CIF/NIE (con prefijo ES y
 * separadores), telefonos y numeros largos.
 */
export function scrubMessage(message: string): string {
  return message
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '"…"')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "'…'")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,4})?\b/gi, "[iban]")
    .replace(/\b(?:ES[ .-]?)?(?:[XYZ][ .-]?\d{7}[ .-]?[A-Z]|\d{8}[ .-]?[A-Z]|[ABCDEFGHJNPQRSUVW][ .-]?\d{7}[ .-]?[0-9A-J])\b/gi, "[nif]")
    .replace(/(?:\+\d{1,3} ?)?\b\d{2,3}(?: \d{2,3}){2,4}\b/g, "[tel]")
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
 * Como mucho `max` avisos en cualquier ventana de `windowMs` (deslizante: con
 * una ventana fija podian salir casi el doble en el cambio de ventana). Los
 * que no pasan se cuentan y se dicen en el siguiente que pase. `now` es de un
 * reloj monotono (performance.now()); si aun asi retrocede, los envios «del
 * futuro» se olvidan en vez de bloquear los avisos mientras dure el salto.
 */
export function createAlertLimiter(max: number, windowMs: number) {
  const sentAt: number[] = [];
  let suppressed = 0;
  return {
    /** null si no toca avisar; si toca, cuantos se callaron antes. */
    take(now: number): { suppressedBefore: number } | null {
      if (sentAt.length > 0 && now < sentAt[sentAt.length - 1]) sentAt.length = 0;
      while (sentAt.length > 0 && now - sentAt[0] >= windowMs) sentAt.shift();
      if (sentAt.length >= max) {
        suppressed++;
        return null;
      }
      sentAt.push(now);
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
  /** Hora del informe. */
  now?: Date;
  /** Reloj del limite de avisos (monotono). */
  clock?: () => number;
};

/** Para Slack: «&», «<» y «>» escapados, asi «<!channel>» o un enlace
 *  inventado en la URL no se interpretan. */
function escapeForChat(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escribe la linea JSON (esperando) y lanza el aviso SIN esperarlo: el
 * servidor es un Node persistente y el POST puede terminar despues, asi que
 * el 500 del usuario no espera al webhook. `delivery` es la promesa del
 * aviso, para los tests.
 */
export async function reportRequestError(
  error: unknown,
  request: ErrorRequest,
  context: ErrorContext,
  deps: Deps = {},
): Promise<{ delivery: Promise<void> }> {
  const report = buildErrorReport(error, request, context, deps.now);
  (deps.log ?? console.error)(JSON.stringify(report));

  const webhookUrl = deps.webhookUrl ?? process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return { delivery: Promise.resolve() };
  const allowed = (deps.limiter ?? limiter).take((deps.clock ?? (() => performance.now()))());
  if (!allowed) return { delivery: Promise.resolve() };
  const extra = allowed.suppressedBefore > 0 ? ` (+${allowed.suppressedBefore} errores sin avisar por el límite)` : "";
  const text = escapeForChat(`Error en FacturOCR: ${report.method} ${report.path} — ${report.name}: ${report.message}${report.digest ? ` [${report.digest}]` : ""}${extra}`);
  const delivery = (async () => {
    try {
      // `text` para Slack/Mattermost, `content` para Discord (sin menciones:
      // allowed_mentions vacio); el resto, para quien lo quiera procesar.
      const res = await (deps.fetchFn ?? fetch)(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text, allowed_mentions: { parse: [] }, ...report, suppressedBefore: allowed.suppressedBefore }),
        signal: AbortSignal.timeout(3_000),
      });
      // El cuerpo no interesa, pero se libera la conexion.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) console.warn(`[alert] el webhook respondio ${res.status}`);
    } catch (err) {
      // Si el webhook falla, no se reintenta ni se lanza: el error ya esta en el log.
      console.warn(`[alert] no se pudo avisar por webhook: ${err instanceof Error ? err.name : "Error"}`);
    }
  })();
  return { delivery };
}
