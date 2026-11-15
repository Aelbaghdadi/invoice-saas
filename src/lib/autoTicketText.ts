/**
 * Tickets automaticos: lo que se escribe en ellos y la huella que agrupa el
 * mismo fallo. Modulo puro (sin Prisma ni Next). Lo que toca la base de
 * datos esta en src/lib/autoTickets.ts.
 *
 * Nada personal: el mensaje pasa por scrubMessage (correos, NIF, IBAN,
 * telefonos, lo entrecomillado) y las rutas van sin parametros.
 */
import { createHash } from "node:crypto";
import { scrubMessage } from "@/lib/errorReporting";
import { SUPPORT_SUBJECT_MAX } from "@/lib/support";

/** De donde viene el error. */
export type AutoTicketKind = "server" | "ocr" | "browser";

export type AutoTicketInput = {
  kind: AutoTicketKind;
  /** Clase del error (Error, TypeError, OcrHttpError, PrismaClientKnownRequestError…). */
  name: string;
  message: string;
  /** Ruta de la peticion o de la pantalla, sin parametros. */
  path?: string | null;
  /** Patron de la ruta de Next (/dashboard/worker/review/[id]), si se sabe. */
  routePath?: string | null;
  /** render, route, action o proxy. */
  routeType?: string | null;
  method?: string | null;
  digest?: string | null;
  stack?: string | null;
  /** Codigo del catalogo (ERR-OCR-001…) en los del OCR. */
  code?: string | null;
  /** Estado HTTP del proveedor en los del OCR. */
  httpStatus?: number | null;
  firmId?: string | null;
  userId?: string | null;
  userAgent?: string | null;
};

const KIND_LABEL: Record<AutoTicketKind, string> = {
  server: "Error del servidor",
  ocr: "Error del OCR",
  browser: "Error en el navegador",
};

const ROUTE_TYPE_LABEL: Record<string, string> = {
  render: "al pintar una pantalla",
  route: "en una ruta de la API",
  action: "en una acción (guardar, validar…)",
  proxy: "en el control de acceso",
};

const MAX_STACK_LINES = 8;
const MAX_PATH = 200;

/**
 * El mensaje sin lo que cambia de una vez a otra: ids (cuid, uuid), hashes,
 * numeros y fechas. Asi dos «Invoice cmv3… not found» son el mismo fallo.
 */
export function normalizeErrorMessage(message: string): string {
  return scrubMessage(message)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ":uuid")
    .replace(/\bc[a-z0-9]{20,30}\b/g, ":id")
    .replace(/\b[0-9a-f]{16,}\b/gi, ":hash")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** La ruta sin parametros y con los ids como «:id», para agrupar /review/cmv1 y /review/cmv2. */
export function normalizePath(path: string | null | undefined): string {
  if (!path) return "";
  return path
    .split("?")[0]
    .split("#")[0]
    .replace(/\/c[a-z0-9]{20,30}(?=\/|$)/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, MAX_PATH);
}

/**
 * Huella del fallo: lo que lo identifica sin lo que cambia de una vez a otra.
 * En el OCR, el codigo y el estado HTTP (un 403 de facturacion son 53
 * facturas, un solo problema); en el resto, la ruta, la clase y el mensaje.
 */
export function errorFingerprint(input: AutoTicketInput): string {
  const parts = input.kind === "ocr"
    ? ["ocr", input.code ?? "", input.name, String(input.httpStatus ?? "")]
    : [input.kind, input.routePath || normalizePath(input.path), input.name, normalizeErrorMessage(input.message)];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** Asunto del ticket, en una linea y dentro del tope del formulario. */
export function autoTicketSubject(input: AutoTicketInput): string {
  const head = input.kind === "ocr" && input.code ? `${KIND_LABEL.ocr} (${input.code})` : KIND_LABEL[input.kind];
  const detail = input.kind === "ocr" && input.httpStatus
    ? `${input.name} ${input.httpStatus}`
    : `${input.name}: ${scrubMessage(input.message).replace(/\s+/g, " ")}`;
  const subject = `${head} · ${detail}`;
  return subject.length > SUPPORT_SUBJECT_MAX ? `${subject.slice(0, SUPPORT_SUBJECT_MAX - 1)}…` : subject;
}

/** Las lineas «at …» de la traza, sin la primera (repite el mensaje sin limpiar). */
export function stackFrames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, MAX_STACK_LINES)
    .map((l) => scrubMessage(l));
}

/** Primer mensaje del ticket: todo lo que hace falta para reproducirlo. */
export function autoTicketBody(input: AutoTicketInput, context: { firmName?: string | null; userName?: string | null; at: Date }): string {
  const lines: string[] = [];
  lines.push(`${KIND_LABEL[input.kind]} detectado automáticamente.`);
  lines.push("");
  lines.push(`Error: ${input.name}`);
  lines.push(`Mensaje: ${scrubMessage(input.message) || "(sin mensaje)"}`);
  if (input.code) lines.push(`Código: ${input.code}`);
  if (input.httpStatus) lines.push(`Respuesta del proveedor: HTTP ${input.httpStatus}`);
  if (input.routeType) lines.push(`Dónde: ${ROUTE_TYPE_LABEL[input.routeType] ?? input.routeType}`);
  const path = normalizePath(input.path);
  if (input.method || path) lines.push(`Ruta: ${[input.method, path].filter(Boolean).join(" ")}`);
  if (input.routePath) lines.push(`Pantalla o ruta de Next: ${input.routePath}`);
  if (input.digest) lines.push(`Digest: ${input.digest}`);
  lines.push(`Asesoría: ${context.firmName ?? "sin sesión"}`);
  lines.push(`Usuario: ${context.userName ?? "sin sesión"}`);
  if (input.userAgent) lines.push(`Navegador: ${input.userAgent.slice(0, 200)}`);
  lines.push(`Primera vez: ${context.at.toISOString()}`);
  const frames = stackFrames(input.stack);
  if (frames.length > 0) {
    lines.push("");
    lines.push("Traza:");
    for (const f of frames) lines.push(`  ${f}`);
  }
  lines.push("");
  lines.push("Si vuelve a pasar, se suma a este ticket mientras siga sin cerrar. Al cerrarlo, la siguiente vez se abre uno nuevo.");
  return lines.join("\n");
}

/** Los errores que no son un fallo de la app: el usuario cerro la pestaña a medias. */
export function isIgnorableError(name: string, message: string): boolean {
  if (name === "AbortError" || name === "ResponseAborted") return true;
  const m = message.toLowerCase();
  return m === "aborted" || m.includes("econnreset") || m.includes("socket hang up");
}
