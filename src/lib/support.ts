/**
 * Soporte: lo que la asesoria le cuenta al equipo del producto (un fallo,
 * una sugerencia, una consulta) y lo que el equipo le contesta.
 *
 * Modulo puro (sin Prisma ni Next): etiquetas, quien ve que, validacion de
 * lo que llega del formulario y el texto de los avisos. Las consultas y las
 * acciones estan en src/app/dashboard/support.
 */
import type { Prisma, SupportTicketStatus, SupportTicketType } from "@prisma/client";
import type { BadgeVariant } from "@/components/ui/Badge";
import type { AllowedFileKind } from "@/lib/fileValidation";

export const SUPPORT_TYPE_LABELS: Record<SupportTicketType, string> = {
  BUG: "Fallo",
  SUGGESTION: "Sugerencia",
  QUESTION: "Consulta",
  OTHER: "Otro",
};

export const SUPPORT_TYPE_HINTS: Record<SupportTicketType, string> = {
  BUG: "Algo no funciona o da un resultado que no es el que esperabas.",
  SUGGESTION: "Una mejora o algo que os haría el trabajo más fácil.",
  QUESTION: "Una duda sobre cómo hacer algo en la aplicación.",
  OTHER: "Cualquier otra cosa.",
};

export const SUPPORT_TYPES: SupportTicketType[] = ["BUG", "SUGGESTION", "QUESTION", "OTHER"];

export const SUPPORT_STATUS_LABELS: Record<SupportTicketStatus, string> = {
  OPEN: "Abierto",
  IN_PROGRESS: "En curso",
  RESOLVED: "Resuelto",
  CLOSED: "Cerrado",
};

export const SUPPORT_STATUS_VARIANT: Record<SupportTicketStatus, BadgeVariant> = {
  OPEN: "blue",
  IN_PROGRESS: "yellow",
  RESOLVED: "green",
  CLOSED: "slate",
};

export const SUPPORT_STATUSES: SupportTicketStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

/** Sin cerrar: lo que sale primero en las listas. */
export const SUPPORT_OPEN_STATUSES: SupportTicketStatus[] = ["OPEN", "IN_PROGRESS"];

export function isSupportTicketType(value: unknown): value is SupportTicketType {
  return typeof value === "string" && (SUPPORT_TYPES as string[]).includes(value);
}

export function isSupportTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === "string" && (SUPPORT_STATUSES as string[]).includes(value);
}

// ─── Quien es del equipo ─────────────────────────────────────────────────────

/**
 * Los usuarios del equipo de soporte, por su nombre de usuario, en
 * SUPPORT_USERNAMES (separados por comas). No hay un rol nuevo: son cuentas
 * normales (de la asesoria que sea) a las que ademas se les abre el panel de
 * todos los tickets.
 */
export function parseSupportStaff(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function isSupportStaff(username: string | null | undefined, raw: string | null | undefined = process.env.SUPPORT_USERNAMES): boolean {
  return !!username && parseSupportStaff(raw).has(username);
}

/** Solo la asesoria abre tickets: un cliente del portal habla con su asesoria. */
export function canUseSupport(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "WORKER";
}

// ─── Quien ve que ────────────────────────────────────────────────────────────

export type SupportActor = {
  id: string;
  role: string;
  advisoryFirmId: string | null | undefined;
  /** Esta en SUPPORT_USERNAMES: ve y contesta los tickets de todas las asesorias. */
  staff: boolean;
};

type TicketScope = { advisoryFirmId: string; createdById: string };

/**
 * Lo que lista cada uno. El equipo, todo; el administrador, los de su
 * asesoria; el gestor, los que abrio el. Sin asesoria no se ve nada: un
 * filtro «undefined» se convertiria en «sin filtro» (F-006).
 */
export function ticketListWhere(actor: SupportActor): Prisma.SupportTicketWhereInput | null {
  if (actor.staff) return {};
  if (!actor.advisoryFirmId || !canUseSupport(actor.role)) return null;
  if (actor.role === "ADMIN") return { advisoryFirmId: actor.advisoryFirmId };
  return { advisoryFirmId: actor.advisoryFirmId, createdById: actor.id };
}

export function canReadTicket(actor: SupportActor, ticket: TicketScope): boolean {
  if (actor.staff) return true;
  if (!actor.advisoryFirmId || ticket.advisoryFirmId !== actor.advisoryFirmId) return false;
  if (actor.role === "ADMIN") return true;
  return actor.role === "WORKER" && ticket.createdById === actor.id;
}

/**
 * A que estados puede pasar un ticket cada uno. El equipo, a cualquiera; la
 * asesoria solo lo da por resuelto o lo reabre. «Cerrado» es del equipo (un
 * ticket que no procede o un duplicado).
 */
export function allowedStatuses(actor: SupportActor, ticket: TicketScope): SupportTicketStatus[] {
  if (!canReadTicket(actor, ticket)) return [];
  if (actor.staff) return [...SUPPORT_STATUSES];
  return ["OPEN", "RESOLVED"];
}

// ─── Validacion del formulario ───────────────────────────────────────────────

export const SUPPORT_SUBJECT_MIN = 3;
export const SUPPORT_SUBJECT_MAX = 120;
export const SUPPORT_BODY_MIN = 10;
export const SUPPORT_BODY_MAX = 5000;

export type TicketInput = { type: SupportTicketType; subject: string; body: string };
export type TicketInputErrors = Partial<Record<"type" | "subject" | "body", string>>;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

export function validateTicketInput(raw: { type: unknown; subject: unknown; body: unknown }):
  | { ok: true; value: TicketInput }
  | { ok: false; errors: TicketInputErrors } {
  const errors: TicketInputErrors = {};
  const subject = text(raw.subject);
  const body = text(raw.body);
  if (!isSupportTicketType(raw.type)) errors.type = "Elige de qué se trata.";
  if (subject.length < SUPPORT_SUBJECT_MIN) errors.subject = `El asunto necesita al menos ${SUPPORT_SUBJECT_MIN} caracteres.`;
  else if (subject.length > SUPPORT_SUBJECT_MAX) errors.subject = `El asunto no puede pasar de ${SUPPORT_SUBJECT_MAX} caracteres.`;
  const bodyError = messageBodyError(body);
  if (bodyError) errors.body = bodyError;
  if (Object.keys(errors).length > 0 || !isSupportTicketType(raw.type)) return { ok: false, errors };
  return { ok: true, value: { type: raw.type, subject, body } };
}

export function messageBodyError(body: string): string | null {
  if (body.length < SUPPORT_BODY_MIN) return `Cuéntanos un poco más: al menos ${SUPPORT_BODY_MIN} caracteres.`;
  if (body.length > SUPPORT_BODY_MAX) return `El mensaje no puede pasar de ${SUPPORT_BODY_MAX} caracteres.`;
  return null;
}

export function validateMessageInput(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  const body = text(raw);
  const error = messageBodyError(body);
  return error ? { ok: false, error } : { ok: true, body };
}

// ─── Contexto del ticket ─────────────────────────────────────────────────────

const MAX_PAGE_PATH = 200;
const MAX_USER_AGENT = 300;

/**
 * La ruta desde la que se abrio el ticket, sin parametros (pueden llevar
 * nombres o correos) y solo si es de la propia app. Un enlace de fuera o una
 * cadena rara no se guarda.
 */
export function pagePathFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let path: string;
  if (trimmed.startsWith("/")) {
    path = trimmed;
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  path = path.split("?")[0].split("#")[0];
  if (!path.startsWith("/dashboard")) return null;
  return path.slice(0, MAX_PAGE_PATH);
}

export function userAgentFrom(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_USER_AGENT) : null;
}

// ─── Adjuntos ────────────────────────────────────────────────────────────────

/** Una captura o un PDF por mensaje, de hasta 5 MB. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_KINDS: AllowedFileKind[] = ["png", "jpeg", "webp", "pdf"];
export const SUPPORT_ATTACHMENT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf";

const ATTACHMENT_EXT: Partial<Record<AllowedFileKind, string>> = { png: "png", jpeg: "jpg", webp: "webp", pdf: "pdf" };

export function isSupportAttachmentKind(kind: AllowedFileKind | null): kind is "png" | "jpeg" | "webp" | "pdf" {
  return kind !== null && SUPPORT_ATTACHMENT_KINDS.includes(kind);
}

/** Carpeta por asesoria y ticket: lo de una asesoria se borra por prefijo. */
export function supportAttachmentKey(firmId: string, ticketId: string, messageId: string, kind: AllowedFileKind): string {
  return `support/${firmId}/${ticketId}/${messageId}.${ATTACHMENT_EXT[kind] ?? "bin"}`;
}

// ─── Avisos al equipo ────────────────────────────────────────────────────────

export type TicketNotice = {
  subject: string;
  type: SupportTicketType;
  firmName: string;
  userName: string;
  url: string;
};

export function newTicketNoticeText(t: TicketNotice): string {
  return `Nuevo ticket de soporte (${SUPPORT_TYPE_LABELS[t.type]}) · ${t.firmName} · ${t.userName}: «${t.subject}» ${t.url}`;
}

export function replyNoticeText(t: TicketNotice & { fromSupport: boolean }): string {
  const who = t.fromSupport ? "Respuesta del equipo" : `Respuesta de ${t.firmName} (${t.userName})`;
  return `${who} en el ticket «${t.subject}» ${t.url}`;
}

/** Orden de las listas: sin cerrar primero y, dentro, lo ultimo que se movio. */
export function ticketSortKey(ticket: { status: SupportTicketStatus; updatedAt: Date }): [number, number] {
  return [SUPPORT_OPEN_STATUSES.includes(ticket.status) ? 0 : 1, -ticket.updatedAt.getTime()];
}
