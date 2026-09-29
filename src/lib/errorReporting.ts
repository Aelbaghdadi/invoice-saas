/**
 * Errores del servidor (F-034) desde instrumentation.ts (onRequestError):
 * una linea JSON en el log y, si hay ALERT_WEBHOOK_URL, un aviso por webhook
 * (Slack, Mattermost o Discord) con un limite para no inundar. Sin SDK de
 * terceros.
 *
 * Sin datos personales: la ruta va sin query (puede llevar nombres o
 * correos), no se mandan cabeceras ni cookies, y el mensaje (ver
 * scrubMessage) pierde lo entrecomillado, correos, IBAN, NIF/CIF/NIE,
 * telefonos y numeros largos, y se recorta.
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
// Una ruta de miles de caracteres (un escaneo, un enlace mal pegado) no
// tiene por que viajar entera al log ni al webhook.
const MAX_PATH = 200;
// Discord rechaza (400) un content de mas de 2000 caracteres.
const MAX_DISCORD_CONTENT = 1_900;
// Se recorta antes de limpiar: sin «@», la expresion de correos prueba desde
// cada posicion hasta el final, y con 100 KB de mensaje (un volcado de
// Prisma) tardaba segundos.
const MAX_SCRUB_INPUT = 2_000;

/**
 * Quita del mensaje lo que puede ser un dato personal:
 * - lo entrecomillado con comillas dobles, aunque la comilla no se cierre
 *   (el mensaje recortado): un PrismaClientValidationError vuelca los
 *   argumentos (`issuerName: "Ana Pérez García"`);
 * - lo entrecomillado con comillas simples que no van pegadas a una letra o
 *   cifra: «Can't resolve 'x'» pierde la 'x' pero no se come el resto;
 * - correos;
 * - IBAN (pais en mayusculas: en minusculas, un UUID parecia un IBAN);
 * - NIF/CIF/NIE, con prefijo ES y separadores («12.345.678-Z»);
 * - telefonos: los formatos de 9 cifras (3-3-3, 3-2-2-2 y 2-3-2-2) con el
 *   mismo separador, espacio, punto o guion, y el prefijo 34 opcional
 *   («612-345-678», «+34 612 34 56 78», «91 123 45 67»). Asi quedan una IP
 *   con puerto, un importe «12.345.678,90», una fecha «28.09.26» o un
 *   «chunk-12-34-56.js», que sirven para depurar. Una IP sin puerto con
 *   forma de telefono («172.31.45.12») sale como telefono;
 * - numeros de 9 o mas cifras.
 */
export function scrubMessage(message: string): string {
  return message
    .slice(0, MAX_SCRUB_INPUT)
    .replace(/"(?:[^"\\\n]|\\.)*(?:"|$)/g, '"…"')
    .replace(/(?<![\p{L}\p{N}])'(?:[^'\\\n]|\\.)*'(?![\p{L}\p{N}])/gu, "'…'")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,4})?\b/g, "[iban]")
    .replace(/\b(?:ES[ .-]?)?(?:[XYZ][ .-]?\d{7}[ .-]?[A-Z]|\d{2}(?:\.?\d{3}){2}[ .-]?[A-Z]|[ABCDEFGHJNPQRSUVW][ .-]?\d{7}[ .-]?[0-9A-J])\b/gi, "[nif]")
    .replace(/(?:\+?34[ .-]?)?\b(?:\d{3}([ .-])\d{3}\1\d{3}|\d{3}([ .-])\d{2}\2\d{2}\2\d{2}|\d{2}([ .-])\d{3}\3\d{2}\3\d{2})\b(?![.:-]?\d)/g, "[tel]")
    .replace(/\d{9,}/g, "[num]")
    .slice(0, MAX_MESSAGE);
}

export function buildErrorReport(error: unknown, request: ErrorRequest, context: ErrorContext, now = new Date()): ErrorReport {
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = (error as { digest?: unknown } | null)?.digest;
  return {
    level: "error",
    time: now.toISOString(),
    path: request.path.split("?")[0].slice(0, MAX_PATH),
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

/**
 * `text` de Slack y Mattermost: «&», «<» y «>» escapados (en Slack,
 * «<!channel>» o un enlace inventado en la URL no se interpretan) y las
 * menciones de Mattermost («@channel», «@all», «@here») rotas con un espacio
 * de ancho cero. Discord no usa este texto: su `content` va sin escapar (lo
 * mostraria tal cual) y sus menciones las apaga allowed_mentions.
 */
function textForSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/@(channel|all|here|everyone)\b/gi, "@\u200b$1");
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
  const plain = `Error en FacturOCR: ${report.method} ${report.path} — ${report.name}: ${report.message}${report.digest ? ` [${report.digest}]` : ""}${extra}`;
  const text = textForSlack(plain);
  const content = plain.slice(0, MAX_DISCORD_CONTENT);
  const delivery = (async () => {
    try {
      // `text` para Slack/Mattermost, `content` para Discord (sin menciones:
      // allowed_mentions vacio); el resto, para quien lo quiera procesar.
      const res = await (deps.fetchFn ?? fetch)(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content, allowed_mentions: { parse: [] }, ...report, suppressedBefore: allowed.suppressedBefore }),
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
