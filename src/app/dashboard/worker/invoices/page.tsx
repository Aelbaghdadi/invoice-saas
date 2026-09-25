import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { MONTH_NAMES } from "@/lib/period";
import { FileText, PenLine, AlertTriangle } from "lucide-react";
import Link from "next/link";
import type { InvoiceType, Prisma } from "@prisma/client";
import { DuplicateRowActions } from "./DuplicateRowActions";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { formatDateEs } from "@/lib/dates";
import { Pagination } from "@/components/ui/Pagination";
import { InvoiceFilters } from "@/components/invoices/InvoiceFilters";
import { parsePage, parseIntInRange, periodMonthFilter } from "@/lib/listing";
import { reviewHref } from "@/lib/reviewNavigation";
import { invoicePageIds, inIdOrder, matchingInvoiceIds, withinIds } from "@/lib/invoiceListing";

const BASE_PATH = "/dashboard/worker/invoices";

type Bucket = "attention" | "clean" | "done" | "all";

function parseBucket(raw: unknown): Bucket {
  if (raw === "attention" || raw === "clean" || raw === "done" || raw === "all") {
    return raw;
  }
  return "attention"; // default: lo que mas trabajo necesita primero
}

/**
 * Construye el where Prisma para cada bucket, respetando los filtros
 * base (cliente, periodo, tipo). Mantiene paridad con reviewQueue.ts
 * para que la "cola" de la pantalla de revision coincida con lo que
 * ve el gestor en el listado.
 */
function whereForBucket(
  bucket: Bucket,
  base: Prisma.InvoiceWhereInput,
): Prisma.InvoiceWhereInput {
  if (bucket === "clean") {
    return {
      ...base,
      status: "PENDING_REVIEW",
      issues: { none: { status: "OPEN" } },
    };
  }
  if (bucket === "attention") {
    return {
      ...base,
      OR: [
        { status: { in: ["NEEDS_ATTENTION", "OCR_ERROR"] } },
        { status: "PENDING_REVIEW", issues: { some: { status: "OPEN" } } },
      ],
    };
  }
  if (bucket === "done") {
    return { ...base, status: { in: ["VALIDATED", "REJECTED", "EXPORTED", "SPLIT_SOURCE"] } };
  }
  return base; // all
}

export default async function WorkerInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    clientId?: string;
    month?: string;
    quarter?: string;
    year?: string;
    type?: string;
    bucket?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");

  const params = await searchParams;
  const clientId = params.clientId;
  const monthFilter = parseIntInRange(params.month, 1, 12);
  const quarterFilter = parseIntInRange(params.quarter, 1, 4);
  const yearFilter = parseIntInRange(params.year, 2000, 2100);
  const typeFilter = params.type === "PURCHASE" || params.type === "SALE" ? params.type : undefined;
  const bucket = parseBucket(params.bucket);
  const q = (params.q ?? "").slice(0, 100);
  const page = parsePage(params.page);

  // ADMIN ve todos los clientes de su firma; WORKER solo los asignados.
  const allowedClientIds = await getAccessibleClientIds(session).catch(() => [] as string[]);
  const scopedClientId = clientId && allowedClientIds.includes(clientId) ? clientId : null;

  const baseWhere: Prisma.InvoiceWhereInput = {
    clientId: scopedClientId ?? { in: allowedClientIds },
    ...(periodMonthFilter(monthFilter, quarterFilter) !== undefined
      ? { periodMonth: periodMonthFilter(monthFilter, quarterFilter) }
      : {}),
    ...(yearFilter ? { periodYear: yearFilter } : {}),
    ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
  };

  // El texto se resuelve una vez sobre el filtro base (sin bandeja), para
  // que la lista y los contadores de las bandejas salgan del mismo conjunto.
  const textIds = await matchingInvoiceIds(baseWhere, q);

  // Contadores por bucket (en paralelo). Asi el gestor ve de un vistazo
  // cuanto tiene en cada bandeja sin tener que cambiar de tab.
  const [countAttention, countClean, countDone, countAll] = await Promise.all([
    prisma.invoice.count({ where: withinIds(whereForBucket("attention", baseWhere), textIds) }).catch(() => 0),
    prisma.invoice.count({ where: withinIds(whereForBucket("clean", baseWhere), textIds) }).catch(() => 0),
    prisma.invoice.count({ where: withinIds(whereForBucket("done", baseWhere), textIds) }).catch(() => 0),
    prisma.invoice.count({ where: withinIds(baseWhere, textIds) }).catch(() => 0),
  ]);

  // Solo la pagina que se ve. Antes venia la bandeja entera de golpe.
  const listWhere = whereForBucket(bucket, baseWhere);
  const { ids, window } = await invoicePageIds({
    where: withinIds(listWhere, textIds),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    page,
  });
  const invoices = ids.length === 0 ? [] : inIdOrder(
    await prisma.invoice
      .findMany({
        // Se repite el filtro de clientes del gestor aunque los ids ya salgan
        // de el: una consulta por id suelta es la que acaba colando datos.
        where: { AND: [listWhere, { id: { in: ids } }] },
        include: {
          client: true,
          issues: {
            where: { status: "OPEN" },
            select: { id: true, type: true, description: true },
          },
          // Si salio alguna vez en un Excel (ver isBatchRejectable).
          exportBatchItems: { take: 1, select: { id: true } },
        },
      })
      .catch(() => []),
    ids,
  );

  // Desplegables: solo los clientes que este gestor puede ver, y los años
  // en los que hay facturas suyas.
  const [clients, yearRows] = await Promise.all([
    prisma.client.findMany({
      where: { id: { in: allowedClientIds }, isUnclassifiedBucket: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }).catch(() => []),
    prisma.invoice.groupBy({
      by: ["periodYear"],
      where: { clientId: { in: allowedClientIds } },
      orderBy: { periodYear: "desc" },
    }).catch(() => []),
  ]);

  // Reconstruye la URL base manteniendo todos los filtros menos `bucket`,
  // para que al cambiar de tab se conserve el resto del contexto.
  const filterParams: Record<string, string | undefined> = {
    clientId: scopedClientId ?? undefined,
    quarter: quarterFilter ? String(quarterFilter) : undefined,
    month: !quarterFilter && monthFilter ? String(monthFilter) : undefined,
    year: yearFilter ? String(yearFilter) : undefined,
    type: typeFilter,
    q: q || undefined,
  };
  const listHref = (extra: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filterParams, ...extra })) if (v) sp.set(k, v);
    const qs = sp.toString();
    return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
  };
  const bucketParam = bucket !== "attention" ? bucket : undefined; // attention es default
  const makeTabHref = (b: Bucket) => listHref({ bucket: b !== "attention" ? b : undefined });

  // Los enlaces a la revision recuerdan la cola (solo clean/attention, que
  // es lo que reviewQueue entiende) y esta misma pagina del listado, con sus
  // filtros: "Volver" lleva aqui y no a la lista sin filtrar.
  const reviewBucket = bucket === "clean" || bucket === "attention" ? bucket : null;
  const thisListHref = listHref({ bucket: bucketParam, page: page > 1 ? String(page) : undefined });

  const tabs: { key: Bucket; label: string; count: number; tone: string }[] = [
    { key: "attention", label: "Con incidencias", count: countAttention, tone: "amber" },
    { key: "clean", label: "Listas para validar", count: countClean, tone: "blue" },
    { key: "done", label: "Cerradas", count: countDone, tone: "slate" },
    { key: "all", label: "Todas", count: countAll, tone: "slate" },
  ];

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${window.total} factura${window.total !== 1 ? "s" : ""} en esta bandeja`}
      />

      {/* Tabs de bandeja: el gestor entra siempre por "Con incidencias"
          porque es lo que requiere accion. */}
      <nav className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-slate-200">
        {tabs.map((t) => {
          const active = t.key === bucket;
          return (
            <Link
              key={t.key}
              href={makeTabHref(t.key)}
              className={
                "relative -mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors " +
                (active
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-700")
              }
            >
              {t.label}
              <span
                className={
                  "inline-flex min-w-[22px] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold " +
                  (active
                    ? "bg-blue-100 text-blue-700"
                    : t.tone === "amber" && t.count > 0
                      ? "bg-amber-100 text-amber-700"
                      : "bg-slate-100 text-slate-500")
                }
              >
                {t.count}
              </span>
            </Link>
          );
        })}
      </nav>

      <InvoiceFilters
        basePath={BASE_PATH}
        clients={clients}
        years={yearRows.map((y) => y.periodYear)}
        values={{
          clientId: scopedClientId ?? "",
          period: quarterFilter ? `t${quarterFilter}` : monthFilter ? `m${monthFilter}` : "",
          year: yearFilter ? String(yearFilter) : "",
          type: typeFilter ?? "",
          q,
        }}
        keep={{ bucket: bucketParam }}
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            // Con texto buscado, el vacio es por la busqueda: decir "Buenas
            // noticias, no hay incidencias" con 12 en la pestaña era mentira.
            title={
              q
                ? "Sin resultados"
                : bucket === "attention"
                  ? "Sin incidencias pendientes"
                  : bucket === "clean"
                    ? "No hay facturas listas para validar"
                    : bucket === "done"
                      ? "Aún no hay facturas cerradas"
                      : "Sin facturas"
            }
            description={
              q
                ? `Ninguna factura de esta bandeja coincide con «${q}». Prueba en «Todas».`
                : bucket === "attention"
                  ? "Buenas noticias: ninguna factura requiere acción manual ahora mismo."
                  : "No hay facturas con estos filtros."
            }
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {/* "Subida" y no "Fecha": es cuando se subio, no la fecha de la factura. */}
                {["Factura", "Cliente", "Periodo", "Tipo", "Estado", "Subida", ""].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv) => {
                const monthName = MONTH_NAMES[inv.periodMonth - 1];
                const duplicateIssue = inv.issues.find((i) => i.type === "POSSIBLE_DUPLICATE");
                const reviewable = ["ANALYZED", "PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR"].includes(inv.status);
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <div className="min-w-0">
                          {/* El nombre del fichero no identifica nada cuando
                              viene de un PDF dividido ("factura1.pdf"). */}
                          <span className="block max-w-[200px] truncate text-[13px] font-medium text-slate-700" title={inv.filename}>
                            {inv.invoiceNumber ?? inv.filename}
                          </span>
                          {(inv.type === "SALE" ? inv.receiverName : inv.issuerName) && (
                            <span className="block max-w-[200px] truncate text-[11px] text-slate-400">
                              {inv.type === "SALE" ? inv.receiverName : inv.issuerName}
                            </span>
                          )}
                          {duplicateIssue && (
                            <span
                              className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-600"
                              title={duplicateIssue.description}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              Posible duplicada
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-slate-500">{inv.client.name}</td>
                    <td className="px-5 py-3 text-[13px] text-slate-500">
                      {monthName} {inv.periodYear}
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                        {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <InvoiceStatusBadge
                        status={inv.status}
                        exported={inv.exportBatchItems.length > 0}
                        pendingReexport={inv.exportBatchItems.length > 0 && inv.exportBatchId == null}
                      />
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-400 whitespace-nowrap">
                      {formatDateEs(inv.createdAt)}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {duplicateIssue && reviewable && (
                          <DuplicateRowActions invoiceId={inv.id} />
                        )}
                        {reviewable && (
                          <Link
                            href={reviewHref(inv.id, { bucket: reviewBucket, back: thisListHref })}
                            className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-100"
                          >
                            <PenLine className="h-3.5 w-3.5" />
                            Revisar
                          </Link>
                        )}
                        {/* Una validada o exportada tambien se abre: si se
                            ve mal en A3 hay que poder encontrarla y corregirla
                            aqui. Antes no tenia ningun enlace. */}
                        {(inv.status === "VALIDATED" || inv.status === "EXPORTED") && (
                          <Link
                            href={reviewHref(inv.id, { back: thisListHref })}
                            className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate-50 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100"
                          >
                            Ver / Corregir
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          window={window}
          hrefFor={(p) => listHref({ bucket: bucketParam, page: p > 1 ? String(p) : undefined })}
        />
      </div>
    </div>
  );
}
