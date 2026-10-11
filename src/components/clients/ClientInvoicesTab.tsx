import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, FileText } from "lucide-react";
import type { InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { Pagination } from "@/components/ui/Pagination";
import { InvoiceFilters } from "@/components/invoices/InvoiceFilters";
import { formatDateEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { periodLabel } from "@/lib/period";
import { parsePage, parseIntInRange, periodMonthFilter } from "@/lib/listing";
import { PENDING_WORK, STATUS_LABELS } from "@/lib/invoiceStatuses";
import { inIdOrder, invoiceOrderBy, invoicePageIds, matchingInvoiceIds, statusCountsWithin, type InvoiceSortKey } from "@/lib/invoiceListing";
import { clientSheetHref } from "@/lib/clientSheet";
import { invoiceHref, type ClientSheetRole } from "./links";

export type InvoicesTabParams = {
  estado?: string;
  month?: string;
  quarter?: string;
  year?: string;
  type?: string;
  q?: string;
  page?: string;
  sort?: string;
  dir?: string;
};

/** Pestañas de estado. «Pendientes» agrupa lo que aun necesita al gestor. */
const STATUS_TABS: { label: string; value: string; statuses: InvoiceStatus[] | null }[] = [
  { label: "Todas", value: "", statuses: null },
  { label: "Pendientes", value: "pendientes", statuses: PENDING_WORK },
  { label: "Por revisar", value: "PENDING_REVIEW", statuses: ["PENDING_REVIEW"] },
  { label: "Con incidencias", value: "NEEDS_ATTENTION", statuses: ["NEEDS_ATTENTION"] },
  { label: "Error OCR", value: "OCR_ERROR", statuses: ["OCR_ERROR"] },
  { label: "Validadas", value: "VALIDATED", statuses: ["VALIDATED"] },
  { label: "Rechazadas", value: "REJECTED", statuses: ["REJECTED"] },
];

const SORTABLE: { key: InvoiceSortKey; label: string; align: "left" | "right" }[] = [
  { key: "factura", label: "Factura", align: "left" },
  { key: "fecha", label: "Fecha", align: "left" },
  { key: "periodo", label: "Periodo", align: "left" },
  { key: "total", label: "Total", align: "right" },
];

/**
 * Todas las facturas del cliente, con los mismos filtros y orden que el
 * listado general, pero sin el desplegable de cliente. Filtrar, ordenar y
 * paginar lo hace el servidor (invoiceListing).
 */
export async function ClientInvoicesTab({
  clientId,
  role,
  basePath,
  params,
}: {
  clientId: string;
  role: ClientSheetRole;
  basePath: string;
  params: InvoicesTabParams;
}) {
  const statusTab = STATUS_TABS.find((t) => t.value === (params.estado ?? "")) ?? STATUS_TABS[0];
  const typeFilter = params.type === "PURCHASE" || params.type === "SALE" ? params.type : undefined;
  const monthFilter = parseIntInRange(params.month, 1, 12);
  const quarterFilter = parseIntInRange(params.quarter, 1, 4);
  const yearFilter = parseIntInRange(params.year, 2000, 2100);
  const q = (params.q ?? "").slice(0, 100);
  const page = parsePage(params.page);
  const { orderBy, sort, dir } = invoiceOrderBy(params.sort, params.dir);

  const periodMonth = periodMonthFilter(monthFilter, quarterFilter);
  const baseWhere: Prisma.InvoiceWhereInput = {
    clientId,
    status: { not: "SPLIT_SOURCE" },
    ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
    ...(periodMonth !== undefined ? { periodMonth } : {}),
    ...(yearFilter ? { periodYear: yearFilter } : {}),
  };
  const listWhere: Prisma.InvoiceWhereInput = statusTab.statuses
    ? { ...baseWhere, status: { in: statusTab.statuses } }
    : baseWhere;

  const textIds = await matchingInvoiceIds(baseWhere, q);
  const { ids, window } = await invoicePageIds({ where: listWhere, textIds, orderBy, page });
  const [invoices, countMap, yearRows] = await Promise.all([
    ids.length === 0 ? [] : prisma.invoice.findMany({
      where: { AND: [listWhere, { id: { in: ids } }] },
      select: {
        id: true, filename: true, invoiceNumber: true, type: true, status: true, issuerName: true, receiverName: true,
        invoiceDate: true, periodType: true, periodMonth: true, periodYear: true, totalAmount: true, createdAt: true,
        exportBatchId: true, exportBatchItems: { take: 1, select: { id: true } },
      },
    }).then((rows) => inIdOrder(rows, ids)),
    statusCountsWithin(baseWhere, textIds).catch((): Partial<Record<InvoiceStatus, number>> => ({})),
    prisma.invoice.groupBy({ by: ["periodYear"], where: { clientId }, orderBy: { periodYear: "desc" } }).catch(() => []),
  ]);

  const countFor = (statuses: InvoiceStatus[] | null) =>
    statuses
      ? statuses.reduce((sum, s) => sum + (countMap[s] ?? 0), 0)
      : Object.values(countMap).reduce((sum, n) => sum + (n ?? 0), 0);

  // Filtros tal como van a la URL; las pestañas y el orden se conservan al filtrar.
  const filterParams = {
    tab: "facturas",
    quarter: quarterFilter ? String(quarterFilter) : undefined,
    month: !quarterFilter && monthFilter ? String(monthFilter) : undefined,
    year: yearFilter ? String(yearFilter) : undefined,
    type: typeFilter,
    q: q || undefined,
  };
  const sortParams = { sort: sort === "fecha" ? undefined : sort, dir: dir === "desc" ? undefined : dir };
  const href = (extra: Record<string, string | undefined>) => clientSheetHref(basePath, { ...filterParams, estado: statusTab.value || undefined, ...sortParams, ...extra });
  const thisHref = href({ page: window.page > 1 ? String(window.page) : undefined });
  const sortHref = (key: InvoiceSortKey) => {
    const nextDir = sort === key ? (dir === "desc" ? "asc" : "desc") : key === "fecha" || key === "total" ? "desc" : "asc";
    return href({ sort: key === "fecha" && nextDir === "desc" ? undefined : key, dir: nextDir === "desc" ? undefined : nextDir });
  };
  const hayFiltros = !!(monthFilter || quarterFilter || yearFilter || typeFilter || q);

  return (
    <div>
      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {STATUS_TABS.map((t) => {
          const active = t.value === statusTab.value;
          return (
            <Link
              key={t.value}
              href={clientSheetHref(basePath, { ...filterParams, estado: t.value || undefined, ...sortParams })}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-all ${
                active ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-blue-500 text-white" : "bg-slate-100 text-slate-500"}`}>
                {countFor(t.statuses)}
              </span>
            </Link>
          );
        })}
      </div>

      <InvoiceFilters
        basePath={basePath}
        clients={[]}
        hideClient
        years={yearRows.map((y) => y.periodYear)}
        values={{
          clientId: "",
          period: quarterFilter ? `t${quarterFilter}` : monthFilter ? `m${monthFilter}` : "",
          year: yearFilter ? String(yearFilter) : "",
          type: typeFilter ?? "",
          q,
        }}
        keep={{ tab: "facturas", estado: statusTab.value || undefined, ...sortParams }}
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description={hayFiltros || statusTab.value ? "No hay facturas con estos filtros." : "Este cliente aún no tiene facturas."}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    {SORTABLE.map((col) => {
                      const active = sort === col.key;
                      const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                      return (
                        <th key={col.key} className={`px-5 py-3 ${col.align === "right" ? "text-right" : "text-left"}`}>
                          <Link href={sortHref(col.key)} className={`inline-flex items-center gap-1 hover:text-slate-700 ${active ? "text-slate-800" : ""}`}>
                            {col.label}
                            <Icon className={`h-3 w-3 ${active ? "text-blue-600" : "text-slate-300"}`} />
                          </Link>
                        </th>
                      );
                    })}
                    <th className="px-5 py-3 text-left">Tipo</th>
                    <th className="px-5 py-3 text-left">Estado</th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {invoices.map((inv) => {
                    const exported = inv.exportBatchItems.length > 0;
                    const counterpart = inv.type === "SALE" ? inv.receiverName : inv.issuerName;
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50/60">
                        <td className="px-5 py-3">
                          <p className="max-w-[260px] truncate font-semibold text-slate-800" title={inv.filename}>{inv.invoiceNumber ?? inv.filename}</p>
                          {counterpart && <p className="max-w-[260px] truncate text-[11px] text-slate-400">{counterpart}</p>}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-slate-600">{formatDateEs(inv.invoiceDate)}</td>
                        <td className="whitespace-nowrap px-5 py-3 text-slate-500">{periodLabel(inv.periodType, inv.periodMonth, inv.periodYear)}</td>
                        <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-700">
                          {inv.totalAmount !== null ? formatEur(Number(inv.totalAmount)) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>{inv.type === "PURCHASE" ? "Recibida" : "Emitida"}</Badge>
                        </td>
                        <td className="px-5 py-3">
                          <InvoiceStatusBadge status={inv.status} exported={exported} pendingReexport={exported && inv.exportBatchId == null} />
                        </td>
                        <td className="px-5 py-3 text-right">
                          <Link
                            href={invoiceHref(role, inv.id, thisHref)}
                            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                          >
                            {role === "WORKER" && PENDING_WORK.includes(inv.status) ? "Revisar" : "Ver"}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination window={window} noun="facturas" hrefFor={(p) => href({ page: p > 1 ? String(p) : undefined })} />
          </>
        )}
      </div>
      {statusTab.value && statusTab.value !== "pendientes" && (
        <p className="mt-2 text-[11px] text-slate-400">Mostrando solo «{STATUS_LABELS[statusTab.value as InvoiceStatus]}».</p>
      )}
    </div>
  );
}
