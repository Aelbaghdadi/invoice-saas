import Link from "next/link";
import {
  AlertTriangle, BookOpen, CheckCircle2, ChevronLeft, Download, FileOutput, FileText, Pencil, XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { CLIENT_TAB_LABELS, clientSheetHref, type ClientStats, type ClientTab } from "@/lib/clientSheet";
import type { ClientSheetClient } from "@/lib/clientSheetData";
import { previousPeriod, exportPageHref } from "@/lib/exportPage";

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-violet-100 text-violet-700",
  "bg-green-100 text-green-700",
  "bg-orange-100 text-orange-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h += c.charCodeAt(0);
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

export type ClientSheetRole = "ADMIN" | "WORKER";

/**
 * Cabecera, cifras y pestañas de la ficha de un cliente. Las dos fichas (la
 * del administrador y la del gestor) la comparten; cambian las pestañas y a
 * donde llevan los enlaces.
 */
export function ClientSheetShell({
  client,
  stats,
  role,
  basePath,
  backHref,
  backLabel,
  tab,
  tabs,
  children,
}: {
  client: ClientSheetClient;
  stats: ClientStats;
  role: ClientSheetRole;
  basePath: string;
  backHref: string;
  backLabel: string;
  tab: ClientTab;
  tabs: ClientTab[];
  children: React.ReactNode;
}) {
  const facturas = (params: Record<string, string | undefined>) => clientSheetHref(basePath, { tab: "facturas", ...params });
  const period = previousPeriod("MONTHLY");

  const cards: { label: string; value: string; href: string; tone: string; icon: typeof FileText }[] = [
    { label: "Facturas", value: stats.total.toLocaleString("es-ES"), href: facturas({}), tone: "text-slate-900", icon: FileText },
    {
      label: "Pendientes",
      value: stats.pending.toLocaleString("es-ES"),
      href: facturas({ estado: "pendientes" }),
      tone: stats.pending > 0 ? "text-amber-700" : "text-slate-900",
      icon: AlertTriangle,
    },
    {
      label: "Listas para exportar",
      value: stats.readyToExport.toLocaleString("es-ES"),
      href: facturas({ estado: "VALIDATED" }),
      tone: "text-slate-900",
      icon: CheckCircle2,
    },
    {
      label: "Exportadas",
      value: stats.exported.toLocaleString("es-ES"),
      href: clientSheetHref(basePath, { tab: role === "ADMIN" ? "exportaciones" : "periodos" }),
      tone: "text-slate-900",
      icon: FileOutput,
    },
    { label: "Rechazadas", value: stats.rejected.toLocaleString("es-ES"), href: facturas({ estado: "REJECTED" }), tone: "text-slate-900", icon: XCircle },
  ];

  return (
    <div>
      <Link href={backHref} className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        {backLabel}
      </Link>

      {/* Cabecera */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5">
        <div className="flex min-w-0 items-center gap-4">
          <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl text-[15px] font-bold ${avatarColor(client.name)}`}>
            {initials(client.name)}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-bold tracking-tight text-slate-900">{client.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-slate-500">
              <span className="font-mono">{client.cif}</span>
              {client.accountingProgram && <Badge variant="slate">{client.accountingProgram}</Badge>}
              {client.equivalenceSurchargeCustomer && <Badge variant="purple">Recargo de equivalencia</Badge>}
              {client.email ? (
                <Badge variant="green">Portal: {client.email}</Badge>
              ) : (
                <span className="text-[12px] italic text-slate-400">Sin acceso al portal</span>
              )}
            </div>
          </div>
        </div>
        {role === "ADMIN" && (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`${basePath}/accounts`}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <BookOpen className="h-4 w-4 text-slate-400" />
              Plan de cuentas
            </Link>
            <Link
              href={exportPageHref({ clientId: client.id, periodType: "MONTHLY", month: period.month, year: period.year, type: "ALL" })}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Download className="h-4 w-4 text-slate-400" />
              Exportar
            </Link>
            <Link
              href={clientSheetHref(basePath, { tab: "ajustes" })}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
            >
              <Pencil className="h-4 w-4" />
              Editar
            </Link>
          </div>
        )}
      </div>

      {/* Cifras */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Link key={c.label} href={c.href} className="card-hover rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-slate-400">
                <Icon className="h-3.5 w-3.5" />
                <span className="text-[11px] font-semibold uppercase tracking-wide">{c.label}</span>
              </div>
              <p className={`mt-1.5 text-[22px] font-bold leading-none tabular-nums ${c.tone}`}>{c.value}</p>
            </Link>
          );
        })}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-slate-400">
            <span className="text-[11px] font-semibold uppercase tracking-wide">Completado</span>
            <span className="text-[13px] font-bold tabular-nums text-slate-700">{stats.pct}%</span>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${stats.pct === 100 ? "bg-emerald-500" : stats.pct >= 50 ? "bg-blue-500" : "bg-amber-400"}`}
              style={{ width: `${stats.pct}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">validadas, rechazadas o exportadas</p>
        </div>
      </div>

      {/* Pestañas */}
      <div className="mb-5 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((t) => {
          const active = t === tab;
          return (
            <Link
              key={t}
              href={clientSheetHref(basePath, { tab: t === "resumen" ? undefined : t })}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
                active ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {CLIENT_TAB_LABELS[t]}
            </Link>
          );
        })}
      </div>

      {children}
    </div>
  );
}
