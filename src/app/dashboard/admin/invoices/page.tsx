import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { FileText, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En análisis", variant: "yellow" },
  VALIDATED: { label: "Validada",    variant: "green" },
  EXPORTED:  { label: "Exportada",   variant: "slate" },
};

const ACTION_LABEL: Record<string, string> = {
  UPLOADED:  "Revisar",
  ANALYZING: "Ver",
  VALIDATED: "Exportar",
  EXPORTED:  "Archivar",
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const params = await searchParams;
  const statusFilter = params.status;
  const typeFilter = params.type;

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(statusFilter ? { status: statusFilter as any } : {}),
      ...(typeFilter ? { type: typeFilter as any } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { client: true },
  }).catch(() => []);

  const counts = await prisma.invoice.groupBy({
    by: ["status"],
    _count: true,
  }).catch(() => []);

  const countMap = Object.fromEntries(counts.map(c => [c.status, c._count]));

  const filters = [
    { label: "Todas", value: "", count: invoices.length },
    { label: "Subidas", value: "UPLOADED", count: countMap.UPLOADED ?? 0 },
    { label: "En análisis", value: "ANALYZING", count: countMap.ANALYZING ?? 0 },
    { label: "Validadas", value: "VALIDATED", count: countMap.VALIDATED ?? 0 },
    { label: "Exportadas", value: "EXPORTED", count: countMap.EXPORTED ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""}${statusFilter ? ` · ${STATUS_BADGE[statusFilter]?.label}` : ""}`}
      />

      {/* Status tabs */}
      <div className="mb-4 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 w-fit shadow-sm">
        {filters.map((f) => {
          const active = (statusFilter ?? "") === f.value;
          return (
            <Link
              key={f.value}
              href={f.value ? `/dashboard/admin/invoices?status=${f.value}` : "/dashboard/admin/invoices"}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
                active ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {f.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-500"}`}>
                {f.count}
              </span>
            </Link>
          );
        })}
      </div>

      {/* Search + filter row */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar por cliente o factura..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <button className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-600 hover:bg-slate-50">
          <SlidersHorizontal className="h-4 w-4 text-slate-400" />
          Filtros
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description="Las facturas aparecerán aquí cuando los clientes suban archivos."
          />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                {["Cliente", "Archivo", "Período", "Tipo", "Estado", "Fecha", "Acciones"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv: any) => {
                const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3.5">
                      <p className="text-[13px] font-semibold text-slate-800">{inv.client.name}</p>
                      <p className="text-[11px] text-slate-400">{inv.client.cif}</p>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 flex-shrink-0 text-slate-300" />
                        <span className="max-w-[140px] truncate text-[13px] text-slate-600">{inv.filename}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-slate-500">
                      {new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "short" })} {inv.periodYear}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                        {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-slate-400">
                      {inv.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/dashboard/admin/invoices/${inv.id}`}
                        className="rounded-lg bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-600 hover:bg-blue-100 transition-colors"
                      >
                        {ACTION_LABEL[inv.status] ?? "Ver"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
