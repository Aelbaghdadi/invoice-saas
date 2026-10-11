"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { canonicalMime, detectFileKind, type AllowedFileKind } from "@/lib/fileValidation";
import { isStorageConfigured, putObject } from "@/lib/storage";
import { supportActorFor } from "@/lib/supportAccess";
import { notifyNewTicket, notifyReply } from "@/lib/supportNotify";
import {
  allowedStatuses,
  canReadTicket,
  canUseSupport,
  isSupportAttachmentKind,
  isSupportTicketStatus,
  pagePathFrom,
  SUPPORT_ATTACHMENT_MAX_BYTES,
  supportAttachmentKey,
  userAgentFrom,
  validateMessageInput,
  validateTicketInput,
  type SupportActor,
  type TicketInputErrors,
} from "@/lib/support";
import type { SupportTicketStatus } from "@prisma/client";

export type TicketFormState = { error?: string; errors?: TicketInputErrors & { attachment?: string } } | undefined;
export type MessageFormState = { error?: string; ok?: boolean; warning?: string } | undefined;

const NO_ACCESS = "No tienes acceso a este ticket.";
const ATTACHMENT_LOST = "El adjunto no se ha podido guardar; el mensaje sí. Puedes volver a adjuntarlo en una respuesta.";

type Attachment = { buffer: Buffer; kind: AllowedFileKind; name: string };

/** El adjunto del formulario, comprobado por sus bytes (no por la extension). */
async function readAttachment(formData: FormData): Promise<{ ok: true; file: Attachment | null } | { ok: false; error: string }> {
  const file = formData.get("attachment");
  if (!(file instanceof File) || file.size === 0) return { ok: true, file: null };
  if (file.size > SUPPORT_ATTACHMENT_MAX_BYTES) return { ok: false, error: "El adjunto no puede pasar de 5 MB." };
  const buffer = Buffer.from(await file.arrayBuffer());
  const kind = detectFileKind(buffer);
  if (!isSupportAttachmentKind(kind)) return { ok: false, error: "Solo se admiten capturas (PNG, JPG o WebP) o un PDF." };
  return { ok: true, file: { buffer, kind, name: (file.name || "adjunto").slice(0, 120) } };
}

/** Sube el adjunto y lo apunta en el mensaje. Si falla, el mensaje queda sin el. */
async function storeAttachment(firmId: string, ticketId: string, messageId: string, file: Attachment): Promise<boolean> {
  if (!isStorageConfigured()) return false;
  const key = supportAttachmentKey(firmId, ticketId, messageId, file.kind);
  const mime = canonicalMime(file.kind);
  try {
    await putObject(key, file.buffer, mime);
    await prisma.supportMessage.update({
      where: { id: messageId },
      data: { attachmentKey: key, attachmentName: file.name, attachmentType: mime },
    });
    return true;
  } catch (err) {
    console.error(`[soporte] no se pudo guardar el adjunto del mensaje ${messageId}:`, err);
    return false;
  }
}

/** El navegador, de la cabecera. Fuera de una peticion (tests) no hay. */
async function userAgentFromRequest(): Promise<string | null> {
  try {
    return userAgentFrom((await headers()).get("user-agent"));
  } catch {
    return null;
  }
}

function revalidateSupport(ticketId?: string) {
  revalidatePath("/dashboard/support");
  revalidatePath("/dashboard/support/team");
  if (ticketId) revalidatePath(`/dashboard/support/${ticketId}`);
}

async function actorFromSession(): Promise<SupportActor | null> {
  const session = await auth();
  if (!session?.user) return null;
  const actor = await supportActorFor(session.user);
  return canUseSupport(actor.role) || actor.staff ? actor : null;
}

/** Abre un ticket. En el formulario con useActionState: en caso de exito redirige al ticket. */
export async function createSupportTicket(_prev: TicketFormState, formData: FormData): Promise<TicketFormState> {
  const session = await auth();
  if (!session?.user || !canUseSupport(session.user.role)) return { error: "No autorizado" };
  const firmId = session.user.advisoryFirmId;
  if (!firmId) return { error: "No autorizado" };

  const parsed = validateTicketInput({ type: formData.get("type"), subject: formData.get("subject"), body: formData.get("body") });
  if (!parsed.ok) return { errors: parsed.errors };
  const attachment = await readAttachment(formData);
  if (!attachment.ok) return { errors: { attachment: attachment.error } };

  // La ruta desde la que vino al formulario (hidden del propio formulario),
  // nunca la del formulario, que no dice nada.
  const rawPage = formData.get("pageUrl");
  const fromPage = pagePathFrom(typeof rawPage === "string" ? rawPage : null);
  const pageUrl = fromPage && !fromPage.startsWith("/dashboard/support") ? fromPage : null;
  const userAgent = await userAgentFromRequest();

  const [firm, user] = await Promise.all([
    prisma.advisoryFirm.findUnique({ where: { id: firmId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true } }),
  ]);
  if (!firm || !user) return { error: "No autorizado" };

  let created: { ticketId: string; messageId: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          advisoryFirmId: firmId,
          createdById: session.user.id,
          type: parsed.value.type,
          subject: parsed.value.subject,
          pageUrl,
          userAgent,
        },
        select: { id: true },
      });
      const message = await tx.supportMessage.create({
        data: { ticketId: ticket.id, authorId: session.user.id, fromSupport: false, body: parsed.value.body },
        select: { id: true },
      });
      return { ticketId: ticket.id, messageId: message.id };
    });
  } catch (err) {
    console.error("[soporte] no se pudo crear el ticket:", err);
    return { error: "No se ha podido enviar. Inténtalo de nuevo." };
  }

  const attachmentSaved = attachment.file
    ? await storeAttachment(firmId, created.ticketId, created.messageId, attachment.file)
    : true;

  after(() => notifyNewTicket({
    ticketId: created.ticketId,
    type: parsed.value.type,
    subject: parsed.value.subject,
    body: parsed.value.body,
    firmName: firm.name,
    userName: user.name,
  }));

  revalidateSupport();
  redirect(`/dashboard/support/${created.ticketId}${attachmentSaved ? "" : "?adjunto=no"}`);
}

/** Una respuesta en el hilo. Contestar reabre lo resuelto; el equipo al contestar lo pone en curso. */
export async function addSupportMessage(ticketId: string, _prev: MessageFormState, formData: FormData): Promise<MessageFormState> {
  const actor = await actorFromSession();
  if (!actor) return { error: "No autorizado" };

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { createdBy: { select: { name: true, email: true } }, advisoryFirm: { select: { name: true } } },
  });
  if (!ticket || !canReadTicket(actor, ticket)) return { error: NO_ACCESS };
  if (ticket.status === "CLOSED" && !actor.staff) {
    return { error: "Este ticket está cerrado. Si sigue pasando, abre uno nuevo." };
  }

  const parsed = validateMessageInput(formData.get("body"));
  if (!parsed.ok) return { error: parsed.error };
  const attachment = await readAttachment(formData);
  if (!attachment.ok) return { error: attachment.error };

  const fromSupport = actor.staff;
  const nextStatus: SupportTicketStatus | null =
    fromSupport && ticket.status === "OPEN" ? "IN_PROGRESS"
    : !fromSupport && ticket.status === "RESOLVED" ? "OPEN"
    : null;

  let messageId: string;
  try {
    messageId = await prisma.$transaction(async (tx) => {
      const message = await tx.supportMessage.create({
        data: { ticketId, authorId: actor.id, fromSupport, body: parsed.body },
        select: { id: true },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        // Sin cambio de estado tambien se toca: updatedAt es «ultimo movimiento».
        data: nextStatus ? { status: nextStatus, resolvedAt: nextStatus === "OPEN" ? null : undefined } : { updatedAt: new Date() },
      });
      return message.id;
    });
  } catch (err) {
    console.error(`[soporte] no se pudo guardar la respuesta en ${ticketId}:`, err);
    return { error: "No se ha podido enviar. Inténtalo de nuevo." };
  }

  const attachmentSaved = attachment.file
    ? await storeAttachment(ticket.advisoryFirmId, ticketId, messageId, attachment.file)
    : true;

  const authorName = (await prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }))?.name ?? "Usuario";
  after(() => notifyReply({
    ticketId,
    type: ticket.type,
    subject: ticket.subject,
    body: parsed.body,
    firmName: ticket.advisoryFirm.name,
    authorName,
    fromSupport,
    author: { name: ticket.createdBy.name, email: ticket.createdBy.email },
  }));

  revalidateSupport(ticketId);
  return attachmentSaved ? { ok: true } : { ok: true, warning: ATTACHMENT_LOST };
}

/** Cambia el estado. La asesoria lo da por resuelto o lo reabre; el equipo, a cualquiera. */
export async function setSupportTicketStatus(ticketId: string, status: string): Promise<{ error: string } | { ok: true }> {
  const actor = await actorFromSession();
  if (!actor) return { error: "No autorizado" };
  if (!isSupportTicketStatus(status)) return { error: "Estado no válido." };

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { advisoryFirmId: true, createdById: true, status: true, resolvedAt: true },
  });
  if (!ticket || !canReadTicket(actor, ticket)) return { error: NO_ACCESS };
  if (!allowedStatuses(actor, ticket).includes(status)) return { error: "No puedes poner este ticket en ese estado." };
  if (ticket.status === status) return { ok: true };

  const done = status === "RESOLVED" || status === "CLOSED";
  try {
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status, resolvedAt: done ? (ticket.resolvedAt ?? new Date()) : null },
    });
  } catch (err) {
    console.error(`[soporte] no se pudo cambiar el estado de ${ticketId}:`, err);
    return { error: "No se ha podido cambiar el estado. Inténtalo de nuevo." };
  }
  revalidateSupport(ticketId);
  return { ok: true };
}
