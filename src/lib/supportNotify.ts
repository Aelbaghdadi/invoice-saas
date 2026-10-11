/**
 * Avisos de soporte: un correo (Resend) y, si hay SUPPORT_WEBHOOK_URL, un
 * mensaje en el canal del equipo (Slack, Mattermost o Discord, el mismo
 * formato que las alertas de errores). Nada de esto puede tumbar la accion:
 * un correo que no sale se queda en el log.
 */
import { notifySupportReply, notifySupportTeamNewTicket } from "@/lib/email";
import { textForSlack } from "@/lib/errorReporting";
import { newTicketNoticeText, replyNoticeText, SUPPORT_TYPE_LABELS, type TicketNotice } from "@/lib/support";
import type { SupportTicketType } from "@prisma/client";

const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export function supportTicketUrl(ticketId: string): string {
  return `${APP_URL}/dashboard/support/${ticketId}`;
}

type Deps = {
  supportEmail?: string;
  webhookUrl?: string;
  fetchFn?: typeof fetch;
};

async function postWebhook(url: string, plain: string, fetchFn: typeof fetch): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `text` para Slack/Mattermost, `content` para Discord (sin menciones).
      body: JSON.stringify({ text: textForSlack(plain), content: plain.slice(0, 1_900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(3_000),
    });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) console.warn(`[soporte] el webhook respondió ${res.status}`);
  } catch (err) {
    console.warn(`[soporte] no se pudo avisar por webhook: ${err instanceof Error ? err.name : "Error"}`);
  }
}

export type NewTicketNotice = {
  ticketId: string;
  type: SupportTicketType;
  subject: string;
  body: string;
  firmName: string;
  userName: string;
};

/** Se ha abierto un ticket: correo al buzon de soporte y aviso al canal. */
export async function notifyNewTicket(t: NewTicketNotice, deps: Deps = {}): Promise<void> {
  const url = supportTicketUrl(t.ticketId);
  const notice: TicketNotice = { subject: t.subject, type: t.type, firmName: t.firmName, userName: t.userName, url };
  const supportEmail = deps.supportEmail ?? process.env.SUPPORT_EMAIL;
  const webhookUrl = deps.webhookUrl ?? process.env.SUPPORT_WEBHOOK_URL;
  await Promise.all([
    supportEmail
      ? notifySupportTeamNewTicket({
          to: supportEmail,
          firmName: t.firmName,
          userName: t.userName,
          typeLabel: SUPPORT_TYPE_LABELS[t.type],
          subject: t.subject,
          body: t.body,
          ticketUrl: url,
        }).catch(() => {})
      : Promise.resolve(),
    webhookUrl ? postWebhook(webhookUrl, newTicketNoticeText(notice), deps.fetchFn ?? fetch) : Promise.resolve(),
  ]);
}

export type ReplyNotice = {
  ticketId: string;
  type: SupportTicketType;
  subject: string;
  body: string;
  firmName: string;
  /** Quien escribe. */
  authorName: string;
  fromSupport: boolean;
  /** Quien abrio el ticket: recibe el correo cuando contesta el equipo. */
  author: { name: string; email: string };
};

/**
 * Una respuesta. Si la escribe el equipo, correo a quien abrio el ticket; si
 * la escribe la asesoria, al buzon de soporte y al canal.
 */
export async function notifyReply(r: ReplyNotice, deps: Deps = {}): Promise<void> {
  const url = supportTicketUrl(r.ticketId);
  const supportEmail = deps.supportEmail ?? process.env.SUPPORT_EMAIL;
  const webhookUrl = deps.webhookUrl ?? process.env.SUPPORT_WEBHOOK_URL;
  const to = r.fromSupport ? r.author.email : supportEmail;
  const recipientName = r.fromSupport ? r.author.name : "equipo";
  await Promise.all([
    to
      ? notifySupportReply({
          to,
          recipientName,
          authorName: r.authorName,
          fromSupport: r.fromSupport,
          subject: r.subject,
          body: r.body,
          ticketUrl: url,
        }).catch(() => {})
      : Promise.resolve(),
    !r.fromSupport && webhookUrl
      ? postWebhook(
          webhookUrl,
          replyNoticeText({ subject: r.subject, type: r.type, firmName: r.firmName, userName: r.authorName, url, fromSupport: false }),
          deps.fetchFn ?? fetch,
        )
      : Promise.resolve(),
  ]);
}
