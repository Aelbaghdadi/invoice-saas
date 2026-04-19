import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileText, X } from "lucide-react";
import Link from "next/link";
import { InvoicesTable } from "./InvoicesTable";
import type { InvoiceStatus, InvoiceType } from "@prisma/client";

const STATUS_BADGE: Record<string, { label: string }> = {
  UPLOADED:  { label: "Subidas" },
  ANALYZING: { label: "En analisis" },
  ANALYZED:  { label: "Analizadas" },
  OCR_ERROR: { label: "Error OCR" },
  VALIDATED: { label: "Validadas" },
  REJECTED:  { label: "Rechazadas" },
  EXPORTED:        { label: "Exportadas" },
  PENDING_REVIEW:  { label: "Pte. revisión" },
  NEEDS_ATTENTION: { label: "Con incidencias" },
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    type?: string;
    clientId?: string;
    month?: string;
    year?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const params = await searchParams;
  const statusFilter = params.status;
  const typeFilter = params.type;
  const clientIdFilter = params.clientId;
  const monthFilter = params.month ? parseInt(params.month, 10) || undefined : undefined;
  const yearFilter = params.year ? parseInt(params.year, 10) || undefined : undefined;

  // Resolve client name for the chip, if filtered by client
  const filteredClient = clientIdFilter
    ? await prisma.client.findFirst({
        where: { id: clientIdFilter, advisoryFirmId: firmId },
        select: { id: true, name: true },
      }).catch(() => null)
    : null;

  const invoices = await prisma.invoice.findMany({
    where: {
      client: { advisoryFirmId: firmId },
      ...(statusFilter ? { status: statusFilter as InvoiceStatus } : {}),
      ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
      ...(clientIdFilter ? { clientId: clientIdFilter } : {}),
      ...(monthFilter ? { periodMonth: monthFilter } : {}),
      ...(yearFilter ? { periodYear: yearFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      client: true,
      auditLogs: { where: { field: "duplicate_warning" }, take: 1 },
    },
  }).catch(() => []);

  const counts = await prisma.invoice.groupBy({
    by: ["status"],
    where: { client: { advisoryFirmId: firmId } },
    _count: true,
  }).catch(() => []);

  const countMap = Object.fromEntries(counts.map(c => [c.status, c._count]));

  const filters = [
    { label: "Todas", value: "", count: invoices.length },
    { label: "Subidas", value: "UPLOADED", count: countMap.UPLOADED ?? 0 },
    { label: "En análisis", value: "ANALYZING", count: countMap.ANALYZING ?? 0 },
    { label: "Pte. revisión", value: "PENDING_REVIEW", count: countMap.PENDING_REVIEW ?? 0 },
    { label: "Con incidencias", value: "NEEDS_ATTENTION", count: countMap.NEEDS_ATTENTION ?? 0 },
    { label: "Error OCR", value: "OCR_ERROR", count: countMap.OCR_ERROR ?? 0 },
    { label: "Validadas", value: "VALIDATED", count: countMap.VALIDATED ?? 0 },
    { label: "Rechazadas", value: "REJECTED", count: countMap.REJECTED ?? 0 },
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
    hasDuplicateWarning: (inv.auditLogs?.length ?? 0) > 0,
  }));

  // Build batch-scope filter chip pieces (client/month/year/type coming from "Ver todas")
  const monthName = (m: number) => new Date(2000, m - 1).toLocaleString("es-ES", { month: "long" });
  const hasBatchFilter = !!(filteredClient || monthFilter || yearFilter || typeFilter);
  const chipParts: string[] = [];
  if (filteredClient) chipParts.push(filteredClient.name);
  if (monthFilter && yearFilter) {
    chipParts.push(`${monthName(monthFilter)} ${yearFilter}`);
  } else if (yearFilter) {
    chipParts.push(String(yearFilter));
  }
  if (typeFilter === "PURCHASE") chipParts.push("Recibidas");
  else if (typeFilter === "SALE") chipParts.push("Emitidas");

  // Preserve status in the "clear" link
  const clearHref = statusFilter
    ? `/dashboard/admin/invoices?status=${statusFilter}`
    : "/dashboard/admin/invoices";

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""}${statusFilter ? ` \u00B7 ${STATUS_BADGE[statusFilter]?.label ?? statusFilter}` : ""}`}
      />

      {hasBatchFilter && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-700">
          <span className="text-blue-400">Filtrado por:</span>
          <span className="capitalize">{chipParts.join(" \u00B7 ")}</span>
          <Link
            href={clearHref}
            className="ml-1 flex h-5 w-5 items-center justify-center rounded-full text-blue-400 hover:bg-blue-100 hover:text-blue-600"
            title="Quitar filtro"
          >
            <X className="h-3 w-3" />
          </Link>
        </div>
      )}

      {/* Status tabs */}
      <div className="mb-4 flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 w-fit shadow-sm">
        {filters.map((f) => {
          const active = (statusFilter ?? "") === f.value;
          // Preserve batch-scope filters when switching status tabs
          const tabParams = new URLSearchParams();
          if (f.value) tabParams.set("status", f.value);
          if (clientIdFilter) tabParams.set("clientId", clientIdFilter);
          if (monthFilter) tabParams.set("month", String(monthFilter));
          if (yearFilter) tabParams.set("year", String(yearFilter));
          if (typeFilter) tabParams.set("type", typeFilter);
          const qs = tabParams.toString();
          return (
            <Link
              key={f.value}
              href={qs ? `/dashboard/admin/invoices?${qs}` : "/dashboard/admin/invoices"}
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
