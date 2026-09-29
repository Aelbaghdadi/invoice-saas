import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { Lock, Unlock, CalendarCheck } from "lucide-react";
import { formatDateTimeEs } from "@/lib/dates";
import { MONTH_NAMES } from "@/lib/period";
import { PAGE_SIZE, pageWindow, parsePage } from "@/lib/listing";
import { ClosuresClient } from "./ClosuresClient";
import { ReopenButton } from "./ReopenButton";

type Props = {
  /** page: cierres activos; reabiertos: pagina de los reabiertos. */
  searchParams?: Promise<{ page?: string; reabiertos?: string }>;
};

export default async function ClosuresPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;
  const sp = (await searchParams) ?? {};

  const firmClosures = { client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } };
  const activeWhere = { ...firmClosures, reopenedAt: null };
  const reopenedWhere = { ...firmClosures, reopenedAt: { not: null } };

  // Antes era una sola lista cortada en 100 (con 50 clientes mensuales, dos
  // meses) y el "historial completo" repetia los cierres activos de arriba.
  const [clients, activeTotal, reopenedTotal] = await Promise.all([
    prisma.client.findMany({
      where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cif: true },
    }),
    prisma.periodClosure.count({ where: activeWhere }),
    prisma.periodClosure.count({ where: reopenedWhere }),
  ]);

  const activeWindow = pageWindow(parsePage(sp.page), activeTotal, PAGE_SIZE);
  const reopenedWindow = pageWindow(parsePage(sp.reabiertos), reopenedTotal, PAGE_SIZE);

  const [activeClosed, reopened] = await Promise.all([
    activeTotal > 0
      ? prisma.periodClosure.findMany({
          where: activeWhere,
          orderBy: [{ year: "desc" }, { month: "desc" }, { id: "asc" }],
          include: { client: { select: { name: true } } },
          skip: activeWindow.skip,
          take: activeWindow.take,
        })
      : [],
    reopenedTotal > 0
      ? prisma.periodClosure.findMany({
          where: reopenedWhere,
          orderBy: [{ reopenedAt: "desc" }, { id: "asc" }],
          include: { client: { select: { name: true } } },
          skip: reopenedWindow.skip,
          take: reopenedWindow.take,
        })
      : [],
  ]);

  // PeriodClosure guarda quien cerro y quien reabrio como id suelto (sin
  // relacion con User): se buscan solo los de estas paginas.
  const userIds = [
    ...new Set(
      [...activeClosed, ...reopened].flatMap((c) => [c.closedBy, c.reopenedBy]).filter((id): id is string => !!id),
    ),
  ];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, advisoryFirmId: firmId },
        select: { id: true, name: true },
      })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const byWhom = (userId: string | null) => (userId ? userName.get(userId) ?? "—" : "—");

  const periodText = (month: number, year: number) => `${MONTH_NAMES[month - 1] ?? month} ${year}`;

  // Cada tabla pagina por su cuenta: el enlace conserva la pagina de la otra.
  const hrefFor = (pages: { page?: number; reabiertos?: number }, anchor: string) => {
    const page = pages.page ?? activeWindow.page;
    const reab = pages.reabiertos ?? reopenedWindow.page;
    const p = new URLSearchParams();
    if (page > 1) p.set("page", String(page));
    if (reab > 1) p.set("reabiertos", String(reab));
    const qs = p.toString();
    return `/dashboard/admin/closures${qs ? `?${qs}` : ""}#${anchor}`;
  };

  return (
    <div>
      <PageHeader
        title="Cierres de periodo"
        description="Cierra periodos mensuales para impedir modificaciones. Los recordatorios se envían automáticamente."
      />

      <ClosuresClient
        clients={clients.map((c) => ({ id: c.id, name: c.name, cif: c.cif }))}
      />

      {/* Active closures */}
      <div id="activos" className="mt-6 scroll-mt-4 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <Lock className="h-4 w-4 text-red-500" />
          <h2 className="text-[14px] font-semibold text-slate-800">
            Periodos cerrados activos ({activeTotal})
          </h2>
        </div>
        {activeTotal === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="Sin cierres activos"
            description="No hay periodos cerrados actualmente."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-5 py-3">Cliente</th>
                    <th className="px-5 py-3">Periodo</th>
                    <th className="px-5 py-3">Cerrado el · por</th>
                    <th className="px-5 py-3">Recordatorio</th>
                    <th className="px-5 py-3">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {activeClosed.map((c) => (
                    <tr key={c.id} className="text-slate-700 hover:bg-slate-50/60">
                      <td className="px-5 py-3 font-medium">{c.client.name}</td>
                      <td className="px-5 py-3">{periodText(c.month, c.year)}</td>
                      <td className="px-5 py-3 text-[12px] text-slate-500">
                        <span className="whitespace-nowrap tabular-nums">{formatDateTimeEs(c.closedAt)}</span>
                        {" · "}
                        {byWhom(c.closedBy)}
                      </td>
                      <td className="px-5 py-3">
                        {c.reminderSent ? (
                          <Badge variant="green">Enviado</Badge>
                        ) : (
                          <Badge variant="yellow">Pendiente</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <ReopenButton
                          closureId={c.id}
                          label={`${c.client.name} · ${periodText(c.month, c.year)}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              window={activeWindow}
              noun="cierres"
              hrefFor={(p) => hrefFor({ page: p }, "activos")}
            />
          </>
        )}
      </div>

      {/* Reabiertos: los activos ya salen arriba, aqui solo lo que se volvio a abrir. */}
      {reopenedTotal > 0 && (
        <div id="reabiertos" className="mt-6 scroll-mt-4 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <Unlock className="h-4 w-4 text-slate-400" />
            <h2 className="text-[14px] font-semibold text-slate-800">
              Periodos reabiertos ({reopenedTotal})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Periodo</th>
                  <th className="px-5 py-3">Cerrado el · por</th>
                  <th className="px-5 py-3">Reabierto el · por</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {reopened.map((c) => (
                  <tr key={c.id} className="text-slate-700 hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-medium">{c.client.name}</td>
                    <td className="px-5 py-3">{periodText(c.month, c.year)}</td>
                    <td className="px-5 py-3 text-[12px] text-slate-500">
                      <span className="whitespace-nowrap tabular-nums">{formatDateTimeEs(c.closedAt)}</span>
                      {" · "}
                      {byWhom(c.closedBy)}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-500">
                      <span className="whitespace-nowrap tabular-nums">{formatDateTimeEs(c.reopenedAt)}</span>
                      {" · "}
                      {byWhom(c.reopenedBy)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            window={reopenedWindow}
            noun="periodos"
            hrefFor={(p) => hrefFor({ reabiertos: p }, "reabiertos")}
          />
        </div>
      )}
    </div>
  );
}
