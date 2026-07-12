import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  Upload,
  ClipboardCheck,
  CheckCircle2,
  FileOutput,
  ArrowRight,
  FileUp,
  ShieldCheck,
  Edit3,
} from "lucide-react";
import Link from "next/link";
import { PENDING_WORK, completionPercent, formatAuditValue, STATUS_LABELS } from "@/lib/invoiceStatuses";
import { formatDateEs } from "@/lib/dates";
import { Badge } from "@/components/ui/Badge";

/* Estado → variante del Badge global; las labels salen de STATUS_LABELS
   (una sola fuente de verdad para el sistema de estados). */
const STATUS_VARIANT: Record<string, React.ComponentProps<typeof Badge>["variant"]> = {
  UPLOADED: "blue",
  ANALYZING: "yellow",
  ANALYZED: "yellow",
  OCR_ERROR: "red",
  VALIDATED: "green",
  REJECTED: "red",
  EXPORTED: "slate",
  PENDING_REVIEW: "blue",
  NEEDS_ATTENTION: "yellow",
  SPLIT_SOURCE: "slate",
  PENDING_ROUTING: "orange",
};

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function avatarColor(name: string) {
  const colors = [
    "bg-blue-100 text-blue-700",
    "bg-green-100 text-green-700",
    "bg-purple-100 text-purple-700",
    "bg-orange-100 text-orange-700",
    "bg-red-100 text-red-700",
    "bg-teal-100 text-teal-700",
  ];
  let hash = 0;
  for (const c of name) hash += c.charCodeAt(0);
  return colors[hash % colors.length];
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Ahora mismo";
  if (mins < 60) return `Hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `Hace ${days}d`;
}

export default async function AdminDashboard() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  // ── Fetch all real data ───────────────────────────────────────────────
  const [
    totalInvoices,
    pendingCount,
    validatedCount,
    exportedCount,
    totalClients,
    recentInvoices,
    recentLogs,
    clientProgress,
  ] = await Promise.all([
    prisma.invoice.count({ where: { client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } } }),
    prisma.invoice.count({ where: { status: { in: PENDING_WORK }, client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } } }),
    prisma.invoice.count({ where: { status: "VALIDATED", client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } } }),
    prisma.invoice.count({ where: { exportBatchId: { not: null }, client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } } }),
    prisma.client.count({ where: { advisoryFirmId: firmId, isUnclassifiedBucket: false } }),
    prisma.invoice.findMany({
      where: { client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { client: true },
    }),
    prisma.auditLog.findMany({
      where: { invoice: { client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } } },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { user: true, invoice: { include: { client: true } } },
    }),
    prisma.client.findMany({
      where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
      include: {
        invoices: { select: { status: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]).catch(() => [0, 0, 0, 0, 0, [], [], []] as const);

  // ── Stat cards (all from DB) ──────────────────────────────────────────
  // Chips de icono unificados en navy: un solo color de marca, sin arcoíris
  // de admin template. El punto de color del subtexto conserva la semántica.
  const stats = [
    {
      label: "Total facturas",
      value: (totalInvoices as number).toLocaleString(),
      sub: `${totalClients} cliente${(totalClients as number) !== 1 ? "s" : ""}`,
      subDotColor: "bg-blue-400",
      icon: Upload,
    },
    {
      label: "Pendientes de validar",
      value: (pendingCount as number).toLocaleString(),
      sub: "subidas + en análisis",
      subDotColor: "bg-amber-400",
      icon: ClipboardCheck,
    },
    {
      label: "Validadas",
      value: (validatedCount as number).toLocaleString(),
      sub: "listas para exportar",
      subDotColor: "bg-emerald-400",
      icon: CheckCircle2,
    },
    {
      label: "Exportadas",
      value: (exportedCount as number).toLocaleString(),
      sub: "enviadas a contabilidad",
      subDotColor: "bg-accent-500",
      icon: FileOutput,
    },
  ];

  // ── Activity icons + field translations ────────────────────────────────
  // Turquesa solo para cambios de estado (validación = acento de marca);
  // el resto de ediciones en neutro para no competir.
  const ACTIVITY_ICON: Record<string, { Icon: typeof FileUp; color: string; bg: string }> = {
    status:        { Icon: ShieldCheck, color: "text-accent-700", bg: "bg-accent-50" },
    default:       { Icon: Edit3,       color: "text-slate-500",  bg: "bg-slate-50"  },
  };

  const FIELD_LABELS: Record<string, string> = {
    status: "estado", issuerName: "emisor", issuerCif: "CIF emisor",
    receiverName: "receptor", receiverCif: "CIF receptor",
    invoiceNumber: "nº factura", invoiceDate: "fecha",
    taxBase: "base imponible", vatRate: "% IVA", vatAmount: "cuota IVA",
    irpfRate: "% IRPF", irpfAmount: "cuota IRPF", totalAmount: "total",
  };

  // ── Clients with pending invoices (for "progress" section) ────────────
  const clientsWithWork = (clientProgress as any[])
    .map((c: any) => {
      const total     = c.invoices.length;
      const pending   = c.invoices.filter((i: any) => PENDING_WORK.includes(i.status)).length;
      const validated = c.invoices.filter((i: any) => i.status === "VALIDATED").length;
      const rejected  = c.invoices.filter((i: any) => i.status === "REJECTED").length;
      const exported  = c.invoices.filter((i: any) => i.status === "EXPORTED").length;
      const done      = validated + rejected + exported;
      const pct       = completionPercent({ total, validated, rejected, exported });
      return { id: c.id, name: c.name, total, pending, done, pct };
    })
    .filter((c) => c.total > 0)
    .sort((a, b) => a.pct - b.pct) // least complete first
    .slice(0, 4);

  return (
    <div className="space-y-5">
      {/* Stat cards */}
      <div className="stagger grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="card-hover animate-fade-in-up rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{s.label}</p>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50/80 ring-1 ring-inset ring-blue-100/70">
                  <Icon className="h-4 w-4 text-blue-600" strokeWidth={1.8} />
                </div>
              </div>
              <p className="mt-2 text-[26px] font-bold leading-none tracking-tight tabular-nums text-slate-900">{s.value}</p>
              <p className="mt-2.5 flex items-center gap-1.5 border-t border-slate-50 pt-2.5 text-[12px] text-slate-500">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.subDotColor}`} />
                {s.sub}
              </p>
            </div>
          );
        })}
      </div>

      {/* Facturas recientes */}
      <div className="animate-fade-in-up overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-3.5">
          <h2 className="text-[15px] font-semibold text-slate-800">Facturas recientes</h2>
          <Link
            href="/dashboard/admin/invoices"
            className="flex items-center gap-1 text-[13px] font-medium text-blue-600 hover:text-blue-700"
          >
            Ver todas
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80">
              {["Cliente", "Archivo", "Período", "Estado", "Fecha", ""].map((h) => (
                <th
                  key={h}
                  className="px-6 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {(recentInvoices as any[]).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-10 text-center text-sm text-slate-400">
                  Sin facturas. Los clientes pueden subir desde su portal.
                </td>
              </tr>
            ) : (
              (recentInvoices as any[]).map((inv) => {
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/80">
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[10px] font-bold ring-2 ring-white shadow-sm ${avatarColor(inv.client.name)}`}>
                          {initials(inv.client.name)}
                        </div>
                        <span className="text-[13px] font-medium text-slate-800">
                          {inv.client.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-3.5 text-[13px] text-slate-600 max-w-[140px] truncate">
                      {inv.filename}
                    </td>
                    <td className="hidden 2xl:table-cell px-6 py-3.5 text-[13px] text-slate-600">
                      {new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "long" })} {inv.periodYear}
                    </td>
                    <td className="px-6 py-3.5">
                      <Badge variant={STATUS_VARIANT[inv.status] ?? "slate"}>
                        {STATUS_LABELS[inv.status as keyof typeof STATUS_LABELS] ?? inv.status}
                      </Badge>
                    </td>
                    <td className="hidden 2xl:table-cell px-6 py-3.5 text-[13px] text-slate-500">
                      {formatDateEs(inv.createdAt)}
                    </td>
                    <td className="px-6 py-3.5">
                      <Link
                        href={`/dashboard/admin/invoices/${inv.id}`}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                      >
                        Ver
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 2xl:grid-cols-5 gap-4">
        {/* Actividad reciente (from AuditLog) */}
        <div className="animate-fade-in-up 2xl:col-span-3 rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-6 py-3.5">
            <h2 className="text-[15px] font-semibold text-slate-800">Actividad reciente</h2>
            <Link
              href="/dashboard/admin/audit"
              className="flex items-center gap-1 text-[13px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todo
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="divide-y divide-slate-50 px-6">
            {(recentLogs as any[]).length === 0 ? (
              <div className="py-8 text-center text-[13px] text-slate-400">
                Sin actividad registrada
              </div>
            ) : (
              (recentLogs as any[]).map((log: any) => {
                const ai = ACTIVITY_ICON[log.field] ?? ACTIVITY_ICON.default;
                const ActionIcon = ai.Icon;
                return (
                  <div
                    key={log.id}
                    className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-3.5 transition-colors duration-150 hover:bg-slate-50/70"
                  >
                    <div className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-slate-100 ${ai.bg}`}>
                      <ActionIcon className={`h-4 w-4 ${ai.color}`} strokeWidth={1.8} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 truncate text-[13px] text-slate-800">
                          <span className="font-semibold">{log.user.name}</span>
                          {" "}cambió{" "}
                          <span className="font-semibold text-slate-600">{FIELD_LABELS[log.field] ?? log.field}</span>
                          {" "}en{" "}
                          <span className="font-medium">{log.invoice.filename}</span>
                        </p>
                        <span className="flex-shrink-0 text-[11px] text-slate-400">
                          {timeAgo(log.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] text-slate-500">
                        {log.invoice.client.name}
                        <span className="mx-1.5 text-slate-300">·</span>
                        {formatAuditValue(log.oldValue)}
                        <span className="mx-1 text-slate-300">→</span>
                        <span className="font-medium text-slate-600">{formatAuditValue(log.newValue)}</span>
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Progreso por cliente (real data) */}
        <div className="animate-fade-in-up 2xl:col-span-2 rounded-2xl border border-slate-200/80 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-6 py-3.5">
            <h2 className="text-[15px] font-semibold text-slate-800">Progreso por cliente</h2>
          </div>
          <div className="divide-y divide-slate-50 px-6">
            {clientsWithWork.length === 0 ? (
              <div className="py-8 text-center text-[13px] text-slate-400">
                Sin facturas pendientes
              </div>
            ) : (
              clientsWithWork.map((c) => (
                <div key={c.id} className="py-4">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-semibold text-slate-800">{c.name}</p>
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                      c.pending > 0
                        ? "bg-amber-50 text-amber-700"
                        : "bg-emerald-50 text-emerald-700"
                    }`}>
                      {c.pending > 0 ? `${c.pending} pendiente${c.pending !== 1 ? "s" : ""}` : "Completado"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      {c.done} de {c.total} factura{c.total !== 1 ? "s" : ""} procesada{c.total !== 1 ? "s" : ""}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-600">{c.pct}%</span>
                  </div>
                  <div className="progress-bar mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full transition-all ${
                        c.pct === 100 ? "bg-emerald-500" : c.pct >= 50 ? "bg-blue-500" : "bg-amber-400"
                      }`}
                      style={{ width: `${c.pct}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
