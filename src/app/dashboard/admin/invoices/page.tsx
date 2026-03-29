import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileText } from "lucide-react";
import Link from "next/link";
import { InvoicesTable } from "./InvoicesTable";

const STATUS_BADGE: Record<string, { label: string }> = {
  UPLOADED:  { label: "Subidas" },
  ANALYZING: { label: "En analisis" },
  VALIDATED: { label: "Validadas" },
  EXPORTED:  { label: "Exportadas" },
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
    { label: "En analisis", value: "ANALYZING", count: countMap.ANALYZING ?? 0 },
    { label: "Validadas", value: "VALIDATED", count: countMap.VALIDATED ?? 0 },
    { label: "Exportadas", value: "EXPORTED", count: countMap.EXPORTED ?? 0 },
  ];

  // Serialize for client component
  const serialized = invoices.map((inv: any) => ({
    id: inv.id,
    filename: inv.filename,
    status: inv.status,
    type: inv.type,
    periodMonth: inv.periodMonth,
    periodYear: inv.periodYear,
    createdAt: inv.createdAt.toISOString(),
    totalAmount: inv.totalAmount !== null ? Number(inv.totalAmount) : null,
    client: { name: inv.client.name, cif: inv.client.cif },
  }));

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""}${statusFilter ? ` \u00B7 ${STATUS_BADGE[statusFilter]?.label ?? statusFilter}` : ""}`}
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

      {invoices.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description="Las facturas apareceran aqui cuando los clientes suban archivos."
          />
        </div>
      ) : (
        <InvoicesTable invoices={serialized} />
      )}
    </div>
  );
}
