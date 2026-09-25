import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { InvoiceFilters } from "@/components/invoices/InvoiceFilters";
import { FileText } from "lucide-react";
import Link from "next/link";
import { InvoicesTable } from "./InvoicesTable";
import { ReprocessAllErrorsButton } from "./ReprocessAllErrorsButton";
import { parsePage, parseIntInRange, periodMonthFilter } from "@/lib/listing";
import { invoicePageIds, inIdOrder, invoiceOrderBy } from "@/lib/invoiceListing";
import type { InvoiceStatus, InvoiceType, Prisma } from "@prisma/client";

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

const BASE_PATH = "/dashboard/admin/invoices";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    type?: string;
    clientId?: string;
    month?: string;
    quarter?: string;
    year?: string;
    q?: string;
    page?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const params = await searchParams;
  const statusFilter = params.status && STATUS_BADGE[params.status] ? params.status : undefined;
  const typeFilter = params.type === "PURCHASE" || params.type === "SALE" ? params.type : undefined;
  const monthFilter = parseIntInRange(params.month, 1, 12);
  const quarterFilter = parseIntInRange(params.quarter, 1, 4);
  const yearFilter = parseIntInRange(params.year, 2000, 2100);
  const q = (params.q ?? "").slice(0, 100);
  const page = parsePage(params.page);
  const { orderBy, sort, dir } = invoiceOrderBy(params.sort, params.dir);

  // Clientes de la asesoria para el desplegable. El cliente de la URL solo se
  // acepta si es uno de estos: un id de otra asesoria no filtra, se ignora.
  const clients = await prisma.client.findMany({
    where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  }).catch(() => []);
  const clientIdFilter = clients.some((c) => c.id === params.clientId) ? params.clientId : undefined;

  // WHERE base SIN el filtro de estado: lo comparten la lista y los contadores
  // de las pestañas, así los números cuadran (antes los contadores eran
  // globales y un sub-conteo podía superar al total o contar con lista vacía).
  // Excluye el buzón "Sin clasificar" (sus facturas son PENDING_ROUTING).
  const periodMonth = periodMonthFilter(monthFilter, quarterFilter);
  const baseWhere: Prisma.InvoiceWhereInput = {
    client: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
    ...(clientIdFilter ? { clientId: clientIdFilter } : {}),
    ...(periodMonth !== undefined ? { periodMonth } : {}),
    ...(yearFilter ? { periodYear: yearFilter } : {}),
  };
  const listWhere: Prisma.InvoiceWhereInput = {
    ...baseWhere,
    ...(statusFilter ? { status: statusFilter as InvoiceStatus } : {}),
  };

  // Solo se cargan las facturas de la pagina que se ve. Antes venian todas
  // las de la asesoria y se paginaba en el navegador.
  const { ids, window } = await invoicePageIds({ where: listWhere, orderBy, q, page });
  const invoices = ids.length === 0 ? [] : inIdOrder(
    await prisma.invoice.findMany({
      // Se repite el filtro de la asesoria aunque los ids ya salgan de el:
      // una consulta por id suelta es justo la que acaba colando datos de otra.
      where: { AND: [listWhere, { id: { in: ids } }] },
      include: {
        client: true,
        auditLogs: { where: { field: "duplicate_warning" }, take: 1 },
        // Si salio alguna vez en un Excel. No vale mirar exportBatchId: al
        // corregir una factura ya exportada ese puntero se pone a null para
        // que vuelva a la cola, y la factura sigue estando en A3.
        exportBatchItems: { take: 1, select: { id: true } },
      },
    }).catch(() => []),
    ids,
  );

  // Contadores por estado con el MISMO baseWhere que la lista (cliente/periodo/tipo).
  const [counts, yearRows] = await Promise.all([
    prisma.invoice.groupBy({ by: ["status"], where: baseWhere, _count: true }).catch(() => []),
    // Años con facturas, para el desplegable.
    prisma.invoice.groupBy({
      by: ["periodYear"],
      where: { client: { advisoryFirmId: firmId, isUnclassifiedBucket: false } },
      orderBy: { periodYear: "desc" },
    }).catch(() => []),
  ]);

  const countMap = Object.fromEntries(counts.map(c => [c.status, c._count]));
  const totalCount = counts.reduce((sum, c) => sum + (typeof c._count === "number" ? c._count : 0), 0);

  const tabs = [
    { label: "Todas", value: "", count: totalCount },
    { label: "Subidas", value: "UPLOADED", count: countMap.UPLOADED ?? 0 },
    { label: "En análisis", value: "ANALYZING", count: countMap.ANALYZING ?? 0 },
    { label: "Pte. revisión", value: "PENDING_REVIEW", count: countMap.PENDING_REVIEW ?? 0 },
    { label: "Con incidencias", value: "NEEDS_ATTENTION", count: countMap.NEEDS_ATTENTION ?? 0 },
    { label: "Error OCR", value: "OCR_ERROR", count: countMap.OCR_ERROR ?? 0 },
    { label: "Validadas", value: "VALIDATED", count: countMap.VALIDATED ?? 0 },
    { label: "Rechazadas", value: "REJECTED", count: countMap.REJECTED ?? 0 },
  ];

  // Filtros actuales tal cual van a la URL. Las pestañas, el orden y la
  // paginacion los conservan; cambiar de filtro vuelve a la primera pagina.
  const filterParams: Record<string, string | undefined> = {
    clientId: clientIdFilter,
    quarter: quarterFilter ? String(quarterFilter) : undefined,
    month: !quarterFilter && monthFilter ? String(monthFilter) : undefined,
    year: yearFilter ? String(yearFilter) : undefined,
    type: typeFilter,
    q: q || undefined,
  };
  const href = (extra: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filterParams, ...extra })) if (v) sp.set(k, v);
    const qs = sp.toString();
    return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
  };
  const sortParams = { sort: sort === "fecha" ? undefined : sort, dir: dir === "desc" ? undefined : dir };

  // Serialize for client component
  const serialized = invoices.map((inv) => ({
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
    // El nombre del fichero no identifica nada cuando viene de un PDF
    // dividido ("factura1.pdf"): el gestor busca por numero de factura o por
    // el tercero, que es lo que ve en A3.
    invoiceNumber: inv.invoiceNumber,
    issuerName: inv.issuerName,
    issuerCif: inv.issuerCif,
    receiverName: inv.receiverName,
    receiverCif: inv.receiverCif,
    exported: (inv.exportBatchItems?.length ?? 0) > 0,
    // Exportada y corregida despues: A3 tiene el dato viejo hasta que se
    // vuelva a exportar.
    pendingReexport: (inv.exportBatchItems?.length ?? 0) > 0 && inv.exportBatchId == null,
  }));

  // Enlaces de ordenacion por columna: pulsar la columna activa invierte el
  // sentido. Van al servidor porque ordenar solo la pagina visible mentia.
  const sortHrefs = Object.fromEntries(
    (["fecha", "factura", "cliente", "periodo", "total"] as const).map((key) => {
      const nextDir = sort === key ? (dir === "desc" ? "asc" : "desc") : key === "fecha" || key === "total" ? "desc" : "asc";
      return [key, href({ status: statusFilter, sort: key === "fecha" && nextDir === "desc" ? undefined : key, dir: nextDir === "desc" ? undefined : nextDir })];
    }),
  ) as Record<"fecha" | "factura" | "cliente" | "periodo" | "total", string>;

  const hayFiltros = !!(clientIdFilter || monthFilter || quarterFilter || yearFilter || typeFilter || q);

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${window.total} factura${window.total !== 1 ? "s" : ""}${statusFilter ? ` · ${STATUS_BADGE[statusFilter]?.label ?? statusFilter}` : ""}`}
      />

      {/* Status tabs */}
      <div className="mb-4 flex w-fit flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
        {tabs.map((f) => {
          const active = (statusFilter ?? "") === f.value;
          return (
            <Link
              key={f.value}
              href={href({ status: f.value || undefined, ...sortParams })}
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

      <InvoiceFilters
        basePath={BASE_PATH}
        clients={clients}
        years={yearRows.map((y) => y.periodYear)}
        values={{
          clientId: clientIdFilter ?? "",
          period: quarterFilter ? `t${quarterFilter}` : monthFilter ? `m${monthFilter}` : "",
          year: yearFilter ? String(yearFilter) : "",
          type: typeFilter ?? "",
          q,
        }}
        keep={{ status: statusFilter, ...sortParams }}
      />

      {statusFilter === "OCR_ERROR" && (
        <ReprocessAllErrorsButton count={countMap.OCR_ERROR ?? 0} />
      )}

      {invoices.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description={hayFiltros || statusFilter
              ? "No hay facturas con estos filtros."
              : "Las facturas aparecerán aquí cuando los clientes suban archivos."}
          />
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <InvoicesTable invoices={serialized} sort={sort} dir={dir} sortHrefs={sortHrefs} />
          <Pagination
            window={window}
            hrefFor={(p) => href({ status: statusFilter, ...sortParams, page: p > 1 ? String(p) : undefined })}
          />
        </div>
      )}
    </div>
  );
}
