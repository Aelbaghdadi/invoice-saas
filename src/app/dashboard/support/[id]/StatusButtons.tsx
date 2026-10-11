"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import type { SupportTicketStatus } from "@prisma/client";
import { setSupportTicketStatus } from "../actions";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { SUPPORT_STATUS_LABELS } from "@/lib/support";

/**
 * La asesoria lo da por resuelto o lo reabre; el equipo elige el estado que
 * sea. `allowed` lo decide el servidor (allowedStatuses) y aqui solo se pinta.
 */
export function StatusButtons({
  ticketId,
  status,
  allowed,
  staff,
}: {
  ticketId: string;
  status: SupportTicketStatus;
  allowed: SupportTicketStatus[];
  staff: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(status);
  const router = useRouter();
  const { success, error } = useToast();

  const change = (next: SupportTicketStatus) => {
    setValue(next);
    startTransition(async () => {
      const res = await setSupportTicketStatus(ticketId, next);
      if ("error" in res) {
        setValue(status);
        error(res.error);
        return;
      }
      success(`Ticket ${SUPPORT_STATUS_LABELS[next].toLowerCase()}`);
      router.refresh();
    });
  };

  if (staff) {
    return (
      <div className="flex items-center gap-2">
        {pending && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
        <Select
          id="ticket-status"
          aria-label="Estado del ticket"
          size="sm"
          className="w-[170px]"
          value={value}
          options={allowed.map((s) => ({ value: s, label: SUPPORT_STATUS_LABELS[s] }))}
          onChange={(v) => change(v as SupportTicketStatus)}
          searchable={false}
          disabled={pending}
        />
      </div>
    );
  }

  if (status === "CLOSED") return null;
  const resolved = status === "RESOLVED";
  const next: SupportTicketStatus = resolved ? "OPEN" : "RESOLVED";
  if (!allowed.includes(next)) return null;
  return (
    <button
      type="button"
      onClick={() => change(next)}
      disabled={pending}
      className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 ${
        resolved
          ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      }`}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : resolved ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      {resolved ? "Reabrir" : "Dar por resuelto"}
    </button>
  );
}
