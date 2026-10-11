import Link from "next/link";
import { MessageSquare, Paperclip } from "lucide-react";
import type { SupportTicketStatus, SupportTicketType } from "@prisma/client";
import { formatDateTimeEs } from "@/lib/dates";
import { TicketStatusBadge, TicketTypeChip } from "./TicketBadges";

export type TicketRow = {
  id: string;
  subject: string;
  type: SupportTicketType;
  status: SupportTicketStatus;
  createdByName: string;
  firmName: string;
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
                    <p className="text-[11px] text-slate-400">Abierto el {formatDateTimeEs(t.createdAt)}</p>
                  </div>
                </div>
              </td>
              {showFirm && <td className="px-5 py-3 text-slate-600">{t.firmName}</td>}
              <td className="px-5 py-3 text-slate-600">{t.createdByName}</td>
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
