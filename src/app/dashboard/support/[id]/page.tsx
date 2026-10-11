import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, Headset, Paperclip } from "lucide-react";
import { formatDateTimeEs } from "@/lib/dates";
import { allowedStatuses, canReadTicket, canUseSupport } from "@/lib/support";
import { supportActorFor } from "@/lib/supportAccess";
import { TicketStatusBadge, TicketTypeChip } from "../TicketBadges";
import { ReplyForm } from "./ReplyForm";
import { StatusButtons } from "./StatusButtons";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ adjunto?: string }> };

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

export default async function SupportTicketPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const actor = await supportActorFor(session.user);
  if (!canUseSupport(actor.role) && !actor.staff) redirect("/dashboard");

  const { id } = await params;
  const { adjunto } = await searchParams;
  const ticket = await prisma.supportTicket.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true } },
      advisoryFirm: { select: { name: true } },
      messages: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } },
    },
  });
  if (!ticket || !canReadTicket(actor, ticket)) notFound();

  const statuses = allowedStatuses(actor, ticket);
  const closedForFirm = ticket.status === "CLOSED" && !actor.staff;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard/support" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Volver a soporte
      </Link>

      {adjunto === "no" && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          El ticket se ha enviado, pero el adjunto no se ha podido guardar. Puedes volver a adjuntarlo en una respuesta.
        </div>
      )}

      {/* Cabecera */}
      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <TicketTypeChip type={ticket.type} />
              <TicketStatusBadge status={ticket.status} />
            </div>
            <h1 className="mt-2 text-[20px] font-bold tracking-tight text-slate-900">{ticket.subject}</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Abierto por <span className="font-medium text-slate-700">{ticket.createdBy.name}</span>
              {actor.staff && <> · <span className="font-medium text-slate-700">{ticket.advisoryFirm.name}</span></>}
              {" "}el {formatDateTimeEs(ticket.createdAt)}
              {ticket.resolvedAt && <> · resuelto el {formatDateTimeEs(ticket.resolvedAt)}</>}
            </p>
          </div>
          <StatusButtons ticketId={ticket.id} status={ticket.status} allowed={statuses} staff={actor.staff} />
        </div>
        {(ticket.pageUrl || (actor.staff && ticket.userAgent)) && (
          <dl className="mt-4 grid gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500 sm:grid-cols-[auto_1fr]">
            {ticket.pageUrl && (
              <>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">Pantalla</dt>
                <dd className="font-mono text-slate-600">{ticket.pageUrl}</dd>
              </>
            )}
            {actor.staff && ticket.userAgent && (
              <>
                <dt className="font-semibold uppercase tracking-wide text-slate-400">Navegador</dt>
                <dd className="break-all text-slate-600">{ticket.userAgent}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      {/* Hilo */}
      <ol className="space-y-3">
        {ticket.messages.map((m) => (
          <li
            key={m.id}
            className={`rounded-xl border p-4 shadow-sm ${
              m.fromSupport ? "border-blue-100 bg-blue-50/50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                m.fromSupport ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"
              }`}>
                {m.fromSupport ? <Headset className="h-3.5 w-3.5" /> : initials(m.author.name)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-slate-800">
                  {m.author.name}
                  {m.fromSupport && <span className="ml-1.5 rounded-md bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">Equipo de soporte</span>}
                </p>
                <p className="text-[11px] text-slate-400">{formatDateTimeEs(m.createdAt)}</p>
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">{m.body}</p>
            {m.attachmentKey && (
              <a
                href={`/api/support/attachments/${m.id}`}
                target="_blank"
                rel="noopener"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
              >
                <Paperclip className="h-3.5 w-3.5 text-slate-400" />
                {m.attachmentName ?? "Adjunto"}
              </a>
            )}
          </li>
        ))}
      </ol>

      {/* Respuesta */}
      <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {closedForFirm ? (
          <p className="text-[13px] text-slate-500">
            Este ticket está cerrado. Si sigue pasando,{" "}
            <Link href="/dashboard/support/new" className="font-medium text-blue-600 hover:text-blue-700">abre uno nuevo</Link>.
          </p>
        ) : (
          <ReplyForm ticketId={ticket.id} staff={actor.staff} resolved={ticket.status === "RESOLVED"} />
        )}
      </div>
    </div>
  );
}
