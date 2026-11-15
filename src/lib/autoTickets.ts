/**
 * Tickets automaticos: cuando la app se encuentra un error inesperado (en el
 * servidor, en el OCR o en el navegador de un usuario) abre un ticket en
 * Soporte para el equipo. El mismo fallo no abre otro: suma una vez mas al
 * que siga sin cerrar (por la huella, ver autoTicketText.ts). Solo los ve el
 * equipo (SUPPORT_USERNAMES); la asesoria no.
 *
 * Nunca lanza ni bloquea mucho: quien llama ya esta gestionando un error, y
 * con la base de datos caida no hay donde apuntarlo (se queda en el log).
 */
import { prisma } from "@/lib/prisma";
import { createAlertLimiter } from "@/lib/errorReporting";
import {
  autoTicketBody,
  autoTicketSubject,
  errorFingerprint,
  isIgnorableError,
  type AutoTicketInput,
} from "@/lib/autoTicketText";
import { SUPPORT_OPEN_STATUSES } from "@/lib/support";
import { notifyNewTicket } from "@/lib/supportNotify";

export type AutoTicketResult = "created" | "counted" | "ignored" | "limited" | "failed";

/** Como mucho 20 tickets nuevos por hora y proceso: los repetidos solo cuentan. */
const creationLimiter = createAlertLimiter(20, 60 * 60_000);
/** Tope de espera: con la base de datos colgada no se retiene la peticion. */
const RECORD_TIMEOUT_MS = 5_000;

type Deps = {
  now?: Date;
  limiter?: ReturnType<typeof createAlertLimiter>;
  clock?: () => number;
  notify?: typeof notifyNewTicket;
};

async function record(input: AutoTicketInput, deps: Deps): Promise<AutoTicketResult> {
  if (isIgnorableError(input.name, input.message)) return "ignored";
  const fingerprint = errorFingerprint(input);
  const now = deps.now ?? new Date();

  const outcome = await prisma.$transaction(async (tx) => {
    // Dos errores iguales a la vez no abren dos tickets.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`support-auto:${fingerprint}`}))`;
    const open = await tx.supportTicket.findFirst({
      where: { fingerprint, source: "AUTO", status: { in: SUPPORT_OPEN_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (open) {
      await tx.supportTicket.update({
        where: { id: open.id },
        data: { occurrences: { increment: 1 }, lastSeenAt: now },
      });
      return { kind: "counted" as const };
    }
    if (!(deps.limiter ?? creationLimiter).take((deps.clock ?? (() => performance.now()))())) {
      return { kind: "limited" as const };
    }

    // La asesoria y el usuario solo si existen y casan entre si: el token
    // puede ser de un usuario borrado.
    const user = input.userId
      ? await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, advisoryFirmId: true } })
      : null;
    const firmId = input.firmId ?? user?.advisoryFirmId ?? null;
    const firm = firmId ? await tx.advisoryFirm.findUnique({ where: { id: firmId }, select: { id: true, name: true } }) : null;
    const subject = autoTicketSubject(input);
    const body = autoTicketBody(input, { firmName: firm?.name ?? null, userName: user?.name ?? null, at: now });

    const ticket = await tx.supportTicket.create({
      data: {
        source: "AUTO",
        type: "BUG",
        status: "OPEN",
        subject,
        fingerprint,
        occurrences: 1,
        lastSeenAt: now,
        advisoryFirmId: firm?.id ?? null,
        createdById: user && (!firm || user.advisoryFirmId === firm.id) ? user.id : null,
        pageUrl: input.path ? input.path.split("?")[0].slice(0, 200) : null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
        messages: { create: { authorId: null, fromSupport: false, body } },
      },
      select: { id: true },
    });
    return { kind: "created" as const, ticketId: ticket.id, subject, body, firmName: firm?.name ?? "Sin asesoría" };
  });

  if (outcome.kind === "created") {
    // Aviso al equipo solo la primera vez: las repeticiones solo cuentan.
    void (deps.notify ?? notifyNewTicket)({
      ticketId: outcome.ticketId,
      type: "BUG",
      subject: outcome.subject,
      body: outcome.body,
      firmName: outcome.firmName,
      userName: "Detección automática",
    }).catch(() => {});
  }
  return outcome.kind;
}

/**
 * Apunta un error inesperado en Soporte. Devuelve que ha hecho; no lanza
 * nunca. Espera como mucho RECORD_TIMEOUT_MS.
 */
export async function recordAutoTicket(input: AutoTicketInput, deps: Deps = {}): Promise<AutoTicketResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"failed">((resolve) => {
      timer = setTimeout(() => resolve("failed"), RECORD_TIMEOUT_MS);
    });
    return await Promise.race([record(input, deps), timeout]);
  } catch (err) {
    console.warn(`[soporte] no se pudo abrir el ticket automático: ${err instanceof Error ? err.name : "Error"}`);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/** Codigos del OCR que son un fallo nuestro o del proveedor, no del documento. */
export const OCR_CODES_FOR_TICKET = new Set(["ERR-OCR-001", "ERR-OCR-005", "ERR-SYS-001"]);

/**
 * Un analisis del OCR que acaba en un error inesperado (ERR-OCR-001, -005,
 * SYS-001). Los del documento (ilegible, original que falta, tardo demasiado)
 * no: son del documento, no de la app. El 403 de facturacion de Gemini del
 * 4 de octubre habria sido un solo ticket con 53 repeticiones.
 */
export async function recordOcrErrorTicket(invoiceId: string, code: string, err: unknown, deps: Deps = {}): Promise<AutoTicketResult> {
  if (!OCR_CODES_FOR_TICKET.has(code)) return "ignored";
  const error = err instanceof Error ? err : new Error(String(err));
  const status = (err as { status?: unknown } | null)?.status;
  const firmId = await prisma.invoice
    .findUnique({ where: { id: invoiceId }, select: { client: { select: { advisoryFirmId: true } } } })
    .then((i) => i?.client.advisoryFirmId ?? null)
    .catch(() => null);
  return recordAutoTicket({
    kind: "ocr",
    code,
    name: error.name,
    message: error.message,
    httpStatus: typeof status === "number" ? status : null,
    stack: error.stack ?? null,
    firmId,
  }, deps);
}

// ─── Errores del servidor (instrumentation.ts) ───────────────────────────────

type RequestInfo = { path: string; method: string; headers: Record<string, string | string[] | undefined> };
type RequestContext = { routePath?: string; routeType?: string };

function toHeaders(raw: RequestInfo["headers"]): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined) continue;
    try {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    } catch {
      // Una cabecera con caracteres que Headers no admite: no hace falta.
    }
  }
  return headers;
}

/**
 * Quien tenia la sesion, del cookie de NextAuth (JWT). En onRequestError no
 * hay auth(): se decodifica con el mismo secreto. Detras del proxy de Coolify
 * el cookie es el «__Secure-»; en local, el normal.
 */
export async function sessionFromHeaders(headers: Headers): Promise<{ userId: string | null; firmId: string | null }> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || !headers.get("cookie")) return { userId: null, firmId: null };
  const { getToken } = await import("next-auth/jwt");
  for (const secureCookie of [true, false]) {
    const token = await getToken({ req: { headers }, secret, secureCookie }).catch(() => null);
    if (token) {
      return {
        userId: typeof token.id === "string" ? token.id : null,
        firmId: typeof token.advisoryFirmId === "string" ? token.advisoryFirmId : null,
      };
    }
  }
  return { userId: null, firmId: null };
}

/** Un error que Next ha capturado en el servidor (render, ruta, accion o proxy). */
export async function recordServerErrorTicket(error: unknown, request: RequestInfo, context: RequestContext, deps: Deps = {}): Promise<AutoTicketResult> {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const digest = (error as { digest?: unknown } | null)?.digest;
    const headers = toHeaders(request.headers);
    const session = await sessionFromHeaders(headers);
    return await recordAutoTicket({
      kind: "server",
      name: err.name,
      message: err.message,
      path: request.path,
      routePath: context.routePath ?? null,
      routeType: context.routeType ?? null,
      method: request.method,
      digest: typeof digest === "string" ? digest : null,
      stack: err.stack ?? null,
      userId: session.userId,
      firmId: session.firmId,
      userAgent: headers.get("user-agent"),
    }, deps);
  } catch {
    return "failed";
  }
}
