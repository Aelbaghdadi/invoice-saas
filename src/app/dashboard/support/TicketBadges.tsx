import type { SupportTicketStatus, SupportTicketType } from "@prisma/client";
import { Badge } from "@/components/ui/Badge";
import { SUPPORT_STATUS_LABELS, SUPPORT_STATUS_VARIANT, SUPPORT_TYPE_LABELS } from "@/lib/support";
import { Bug, HelpCircle, Lightbulb, MessageSquare } from "lucide-react";

const TYPE_ICON: Record<SupportTicketType, typeof Bug> = {
  BUG: Bug,
  SUGGESTION: Lightbulb,
  QUESTION: HelpCircle,
  OTHER: MessageSquare,
};

const TYPE_COLOR: Record<SupportTicketType, string> = {
  BUG: "bg-red-50 text-red-600 ring-red-100",
  SUGGESTION: "bg-amber-50 text-amber-600 ring-amber-100",
  QUESTION: "bg-blue-50 text-blue-600 ring-blue-100",
  OTHER: "bg-slate-50 text-slate-500 ring-slate-100",
};

export function TicketTypeChip({ type, iconOnly = false }: { type: SupportTicketType; iconOnly?: boolean }) {
  const Icon = TYPE_ICON[type];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${TYPE_COLOR[type]}`}
      title={SUPPORT_TYPE_LABELS[type]}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      {!iconOnly && SUPPORT_TYPE_LABELS[type]}
    </span>
  );
}

export function TicketStatusBadge({ status }: { status: SupportTicketStatus }) {
  return <Badge variant={SUPPORT_STATUS_VARIANT[status]}>{SUPPORT_STATUS_LABELS[status]}</Badge>;
}
