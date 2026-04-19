import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { FileText, PenLine, X } from "lucide-react";
import Link from "next/link";
import type { InvoiceType } from "@prisma/client";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",       variant: "blue" },
  ANALYZING: { label: "En análisis",  variant: "yellow" },
  ANALYZED:  { label: "Analizada",    variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",    variant: "red" },
  VALIDATED: { label: "Validada",     variant: "green" },
  REJECTED:  { label: "Rechazada",    variant: "red" },
  EXPORTED:        { label: "Exportada",      variant: "slate" },
  PENDING_REVIEW:  { label: "Pte. revisión",  variant: "blue" },
  NEEDS_ATTENTION: { label: "Con incidencias", variant: "yellow" },
};

export default async function WorkerInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    clientId?: string;
    month?: string;
    year?: string;
    type?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const params = await searchParams;
  const clientId = params.clientId;
  const monthFilter = params.month ? parseInt(params.month, 10) || undefined : undefined;
  const yearFilter = params.year ? parseInt(params.year, 10) || undefined : undefined;
  const typeFilter = params.type;

  // Get all client IDs assigned to this worker
  const assignments = await prisma.workerClientAssignment
    .findMany({ where: { workerId: session.user.id }, select: { clientId: true } })
    .catch(() => []);

  const allowedClientIds = assignments.map((a) => a.clientId);
  const scopedClientId = clientId && allowedClientIds.includes(clientId) ? clientId : null;

  const invoices = await prisma.invoice
    .findMany({
      where: {
        clientId: scopedClientId ?? { in: allowedClientIds },
        ...(monthFilter ? { periodMonth: monthFilter } : {}),
        ...(yearFilter ? { periodYear: yearFilter } : {}),
        ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
      },
      include: { client: true },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => []);

  const filteredClient = scopedClientId
    ? await prisma.client.findUnique({
        where: { id: scopedClientId },
        select: { name: true },
      }).catch(() => null)
    : null;

  const monthName = (m: number) => new Date(2000, m - 1).toLocaleString("es-ES", { month: "long" });
  const hasBatchFilter = !!(filteredClient || monthFilter || yearFilter || typeFilter);
  const chipParts: string[] = [];
  if (filteredClient) chipParts.push(filteredClient.name);
  if (monthFilter && yearFilter) chipParts.push(`${monthName(monthFilter)} ${yearFilter}`);
  else if (yearFilter) chipParts.push(String(yearFilter));
  if (typeFilter === "PURCHASE") chipParts.push("Recibidas");
  else if (typeFilter === "SALE") chipParts.push("Emitidas");

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""}`}
      />

      {hasBatchFilter && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-700">
          <span className="text-blue-400">Filtrado por:</span>
          <span className="capitalize">{chipParts.join(" \u00B7 ")}</span>
          <Link
            href="/dashboard/worker/invoices"
            className="ml-1 flex h-5 w-5 items-center justify-center rounded-full text-blue-400 hover:bg-blue-100 hover:text-blue-600"
            title="Quitar filtro"
          >
            <X className="h-3 w-3" />
          </Link>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description="No hay facturas disponibles para tus clientes asignados."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {["Archivo", "Cliente", "Período", "Tipo", "Estado", "Fecha", ""].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv) => {
                const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
                const monthName = new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "short" });
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <span className="max-w-[160px] truncate text-[13px] font-medium text-slate-700">
                          {inv.filename}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-slate-500">{inv.client.name}</td>
                    <td className="px-5 py-3 text-[13px] capitalize text-slate-500">
                      {monthName} {inv.periodYear}
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                        {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-400 whitespace-nowrap">
                      {inv.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-5 py-3">
                      {["ANALYZED", "PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR"].includes(inv.status) && (
                        <Link
                          href={`/dashboard/worker/review/${inv.id}`}
                          className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-100"
                        >
                          <PenLine className="h-3.5 w-3.5" />
                          Revisar
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
