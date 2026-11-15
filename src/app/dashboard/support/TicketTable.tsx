import Link from "next/link";
import { Bot, MessageSquare, Paperclip } from "lucide-react";
import type { SupportTicketSource, SupportTicketStatus, SupportTicketType } from "@prisma/client";
import { formatDateTimeEs } from "@/lib/dates";
import { TicketStatusBadge, TicketTypeChip } from "./TicketBadges";

export type TicketRow = {
  id: string;
  subject: string;
  type: SupportTicketType;
  status: SupportTicketStatus;
  source: SupportTicketSource;
  /** Veces que ha pasado (automaticos). */
  occurrences: number;
  createdByName: string | null;
  firmName: string | null;
  createdAt: Date;
  updatedAt: Date;
  messages: number;
  hasAttachment: boolean;
};

/** Lista de tickets. La columna de asesoria solo la ve el equipo. */
export function TicketTable({ rows, showFirm }: { rows: TicketRow[]; showFirm: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <th className="px-5 py-3">Ticket</th>
            {showFirm && <th className="px-5 py-3">Asesoría</th>}
            <th className="px-5 py-3">Abierto por</th>
            <th className="px-5 py-3">Estado</th>
            <th className="px-5 py-3 text-right">Mensajes</th>
            <th className="px-5 py-3">Último movimiento</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((t) => (
            <tr key={t.id} className="text-slate-700 hover:bg-slate-50/60">
              <td className="px-5 py-3">
                <div className="flex items-center gap-2.5">
                  <TicketTypeChip type={t.type} iconOnly />
                  <div className="min-w-0">
                    <Link href={`/dashboard/support/${t.id}`} className="block max-w-[420px] truncate font-semibold text-slate-800 hover:text-blue-700">
                      {t.subject}
                    </Link>
                    <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      {t.source === "AUTO" && (
                        <span className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 font-semibold text-violet-700">
                          <Bot className="h-3 w-3" />
                          Automático{t.occurrences > 1 ? ` · ${t.occurrences.toLocaleString("es-ES")} veces` : ""}
                        </span>
                      )}
                      Abierto el {formatDateTimeEs(t.createdAt)}
                    </p>
                  </div>
                </div>
              </td>
              {showFirm && <td className="px-5 py-3 text-slate-600">{t.firmName ?? <span className="text-slate-400">Sin asesoría</span>}</td>}
              <td className="px-5 py-3 text-slate-600">
                {t.createdByName ?? <span className="text-slate-400">{t.source === "AUTO" ? "La aplicación" : "—"}</span>}
              </td>
              <td className="px-5 py-3"><TicketStatusBadge status={t.status} /></td>
              <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                <span className="inline-flex items-center gap-1.5">
                  {t.hasAttachment && <Paperclip className="h-3.5 w-3.5 text-slate-400" />}
                  <MessageSquare className="h-3.5 w-3.5 text-slate-400" />
                  {t.messages}
                </span>
              </td>
              <td className="whitespace-nowrap px-5 py-3 tabular-nums text-slate-500">{formatDateTimeEs(t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
