import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { LifeBuoy, Plus, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { PAGE_SIZE, pageWindow, parsePage } from "@/lib/listing";
import { canUseSupport, SUPPORT_OPEN_STATUSES, ticketListWhere } from "@/lib/support";
import { supportActorFor } from "@/lib/supportAccess";
import { TicketTable, type TicketRow } from "./TicketTable";

type Props = { searchParams: Promise<{ estado?: string; page?: string }> };

/**
 * Los tickets de quien mira: el administrador ve los de su asesoria y el
 * gestor los suyos. Por defecto, los que siguen sin cerrar.
 */
export default async function SupportPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canUseSupport(session.user.role)) redirect("/dashboard");
  const actor = await supportActorFor(session.user);
  // El equipo ve aqui los suyos como cualquier usuario; todos, en su panel.
  const scope = ticketListWhere({ ...actor, staff: false });
  if (!scope) redirect("/dashboard");

  const sp = await searchParams;
  const todos = sp.estado === "todos";
  const where = todos ? scope : { ...scope, status: { in: SUPPORT_OPEN_STATUSES } };

  const [openCount, allCount] = await Promise.all([
    prisma.supportTicket.count({ where: { ...scope, status: { in: SUPPORT_OPEN_STATUSES } } }),
    prisma.supportTicket.count({ where: scope }),
  ]);
  const total = todos ? allCount : openCount;
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

  const hrefFor = (page: number) => {
    const qs = new URLSearchParams();
    if (todos) qs.set("estado", "todos");
    if (page > 1) qs.set("page", String(page));
    const s = qs.toString();
    return s ? `/dashboard/support?${s}` : "/dashboard/support";
  };

  return (
    <div>
      <PageHeader
        title="Soporte"
        description="¿Algo no funciona, tienes una duda o se te ocurre una mejora? Cuéntanoslo aquí y te contestamos en el propio ticket."
        action={
          <div className="flex items-center gap-2">
            {actor.staff && (
              <Link
                href="/dashboard/support/team"
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
              >
                <Users className="h-4 w-4 text-slate-400" />
                Panel del equipo
              </Link>
            )}
            <Link
              href="/dashboard/support/new"
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              Nuevo ticket
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex w-fit items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {[
          { label: "Sin cerrar", href: "/dashboard/support", active: !todos, count: openCount },
          { label: "Todos", href: "/dashboard/support?estado=todos", active: todos, count: allCount },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
              tab.active ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${tab.active ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-500"}`}>
              {tab.count}
            </span>
          </Link>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {rows.length === 0 ? (
          <EmptyState
            icon={LifeBuoy}
            title={todos ? "Sin tickets" : "Nada sin cerrar"}
            description={todos
              ? "Cuando abras un ticket aparecerá aquí, con su estado y las respuestas."
              : "No tienes tickets abiertos. Si algo falla o tienes una duda, abre uno."}
            action={
              <Link
                href="/dashboard/support/new"
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Nuevo ticket
              </Link>
            }
          />
        ) : (
          <>
            <TicketTable rows={rows} showFirm={false} />
            <Pagination window={window} noun={["ticket", "tickets"]} hrefFor={hrefFor} />
          </>
        )}
      </div>
    </div>
  );
}
