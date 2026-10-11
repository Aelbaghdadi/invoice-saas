import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Inbox } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { PAGE_SIZE, pageWindow, parsePage } from "@/lib/listing";
import { isSupportTicketStatus, SUPPORT_OPEN_STATUSES, SUPPORT_STATUS_LABELS, SUPPORT_STATUSES } from "@/lib/support";
import { supportActorFor } from "@/lib/supportAccess";
import { TicketTable, type TicketRow } from "../TicketTable";
import type { Prisma } from "@prisma/client";

type Props = { searchParams: Promise<{ estado?: string; page?: string }> };

/**
 * Panel del equipo (SUPPORT_USERNAMES): los tickets de todas las asesorias.
 * Es la unica pantalla que cruza asesorias a proposito.
 */
export default async function SupportTeamPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const actor = await supportActorFor(session.user);
  if (!actor.staff) redirect("/dashboard/support");

  const sp = await searchParams;
  const estado = sp.estado ?? "";
  const where: Prisma.SupportTicketWhereInput = isSupportTicketStatus(estado)
    ? { status: estado }
    : estado === "todos" ? {} : { status: { in: SUPPORT_OPEN_STATUSES } };

  const [byStatus, total] = await Promise.all([
    prisma.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.supportTicket.count({ where }),
  ]);
  const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const allCount = byStatus.reduce((sum, r) => sum + r._count._all, 0);
  const openCount = SUPPORT_OPEN_STATUSES.reduce((sum, s) => sum + count(s), 0);

  const window = pageWindow(parsePage(sp.page), total, PAGE_SIZE);
  const tickets = total > 0
    ? await prisma.supportTicket.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: window.skip,
        take: window.take,
        include: {
          createdBy: { select: { name: true } },
          advisoryFirm: { select: { name: true } },
          _count: { select: { messages: true } },
          messages: { where: { attachmentKey: { not: null } }, select: { id: true }, take: 1 },
        },
      })
    : [];

  const rows: TicketRow[] = tickets.map((t) => ({
    id: t.id,
    subject: t.subject,
    type: t.type,
    status: t.status,
    createdByName: t.createdBy.name,
    firmName: t.advisoryFirm.name,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: t._count.messages,
    hasAttachment: t.messages.length > 0,
  }));

  const hrefFor = (page: number, estadoValue = estado) => {
    const qs = new URLSearchParams();
    if (estadoValue) qs.set("estado", estadoValue);
    if (page > 1) qs.set("page", String(page));
    const s = qs.toString();
    return s ? `/dashboard/support/team?${s}` : "/dashboard/support/team";
  };

  const tabs = [
    { label: "Sin cerrar", value: "", count: openCount },
    ...SUPPORT_STATUSES.map((s) => ({ label: SUPPORT_STATUS_LABELS[s], value: s, count: count(s) })),
    { label: "Todos", value: "todos", count: allCount },
  ];

  return (
    <div>
      <Link href="/dashboard/support" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Mis tickets
      </Link>
      <PageHeader title="Panel del equipo de soporte" description="Los tickets de todas las asesorías. Lo que contestes aquí les llega por correo." />

      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((tab) => {
          const active = estado === tab.value;
          return (
            <Link
              key={tab.value}
              href={hrefFor(1, tab.value)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
                active ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-500"}`}>
                {tab.count}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState icon={Inbox} title="Sin tickets" description="No hay tickets en este estado." />
        ) : (
          <>
            <TicketTable rows={rows} showFirm />
            <Pagination window={window} noun={["ticket", "tickets"]} hrefFor={(p) => hrefFor(p)} />
          </>
        )}
      </div>
    </div>
  );
}
