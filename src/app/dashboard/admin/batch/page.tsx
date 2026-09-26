import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, ArrowRight, PenLine, Loader2,
} from "lucide-react";
import Link from "next/link";
import type { InvoiceType, PeriodType } from "@prisma/client";
import { completionPercent, isBatchRejectable } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";
import { QUEUE_ORDER } from "@/lib/reviewQueue";
import { reviewHref } from "@/lib/reviewNavigation";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { BatchFilters } from "@/components/batch/BatchFilters";
import { ClientAccordionSection } from "@/components/batch/ClientAccordionSection";
import { BatchActions } from "@/app/dashboard/worker/batch/BatchActions";

// La pagina muestra estados de OCR en curso — la marcamos dynamic para
// que el conteo no quede cacheado entre cargas.
export const dynamic = "force-dynamic";

// Mismos buckets y pildoras que la pantalla de lotes del gestor: el mismo
// lote se describia distinto segun el rol. El admin tiene un solo boton,
// "Revisar (n)", que recorre todas las pendientes (incidencias y listas); su
// numero es el de la cola: antes contaba facturas aun en OCR (que no estan
// en ella) y no las de Error OCR (que si).
type BatchGroup = {
  clientId: string;
  clientName: string;
  clientCif: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  type: InvoiceType;
  total: number;
  attentionCount: number;     // NEEDS_ATTENTION + OCR_ERROR + PENDING_REVIEW con issue OPEN
  cleanCount: number;         // PENDING_REVIEW sin issues
  processingCount: number;    // UPLOADED + ANALYZING + ANALYZED (legacy)
  /** Solo UPLOADED + ANALYZING: lo que el OCR tiene de verdad en marcha. */
  ocrRunning: number;
  validated: number;
  rejected: number;
  exported: number;
  ocrError: number;
  /** Lo que tocaria "Rechazar lote" (mismo criterio que la accion). */
  rejectable: number;
  rejectableValidated: number;
  /** Primera pendiente del lote en el orden de la cola (QUEUE_ORDER). */
  firstPendingId: string | null;
};

export default async function BatchPage({
  searchParams,
}: {
  searchParams?: Promise<{ clientId?: string; year?: string; month?: string; type?: string; estado?: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  // Filtros (URL): cliente / año / mes / tipo / estado.
  const sp = (await searchParams) ?? {};
  const estado = sp.estado ?? "pendientes";
  const yearNum = sp.year ? parseInt(sp.year, 10) : null;
  const monthNum = sp.month ? parseInt(sp.month, 10) : null;
  const typeParam = sp.type === "PURCHASE" || sp.type === "SALE" ? sp.type : null;

  // Clientes de la firma para el desplegable de filtros.
  const clientOptions = await prisma.client.findMany({
    where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const requestedClient =
    sp.clientId && clientOptions.some((c) => c.id === sp.clientId) ? sp.clientId : null;
  const hasFilters = Boolean(requestedClient || yearNum || monthNum || typeParam);

  // URL de esta pantalla con los filtros activos y el estado dado: para
  // "Ver todos" y para que "Volver" desde la revision traiga aqui.
  const basePath = "/dashboard/admin/batch";
  const listHref = (estadoValue: string) => {
    const p = new URLSearchParams();
    if (requestedClient) p.set("clientId", requestedClient);
    if (yearNum) p.set("year", String(yearNum));
    if (monthNum) p.set("month", String(monthNum));
    if (typeParam) p.set("type", typeParam);
    if (estadoValue !== "pendientes") p.set("estado", estadoValue);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const thisListHref = listHref(estado);

  const invoices = await prisma.invoice.findMany({
    where: {
      // Excluir el buzón "Sin clasificar" (sus facturas son PENDING_ROUTING):
      // no es un cliente real, no debe aparecer como un lote más.
      client: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
      ...(requestedClient ? { clientId: requestedClient } : {}),
      ...(yearNum ? { periodYear: yearNum } : {}),
      ...(monthNum ? { periodMonth: monthNum } : {}),
      ...(typeParam ? { type: typeParam } : {}),
    },
    include: {
      client: { select: { id: true, name: true, cif: true } },
      issues: { where: { status: "OPEN" }, select: { id: true } },
      // Salio alguna vez en un Excel (ver isBatchRejectable).
      exportBatchItems: { take: 1, select: { id: true } },
    },
    // Dentro de cada lote, el orden de la cola de revision: la primera que
    // abren los botones es la 1 de N y no una pospuesta.
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, ...QUEUE_ORDER],
  });

  // Group by client + period
  const groupMap = new Map<string, BatchGroup>();

  for (const inv of invoices) {
    // La original de una division no es una factura mas: sus hijas ya estan
    // en la lista. Contarla dejaba el lote sin llegar nunca a "Completado".
    if (inv.status === "SPLIT_SOURCE") continue;
    const key = `${inv.clientId}-${inv.periodYear}-${inv.periodMonth}-${inv.periodType}-${inv.type}`;
    let g = groupMap.get(key);
    if (!g) {
      g = {
        clientId: inv.clientId,
        clientName: inv.client.name,
        clientCif: inv.client.cif,
        periodType: inv.periodType,
        periodMonth: inv.periodMonth,
        periodYear: inv.periodYear,
        type: inv.type,
        total: 0,
        attentionCount: 0,
        cleanCount: 0,
        processingCount: 0,
        ocrRunning: 0,
        validated: 0,
        rejected: 0,
        exported: 0,
        ocrError: 0,
        rejectable: 0,
        rejectableValidated: 0,
        firstPendingId: null,
      };
      groupMap.set(key, g);
    }
    g.total++;
    const hasOpenIssue = inv.issues.length > 0;

    // Exportar no cambia el estado. Sin mirar el historial las exportadas
    // salian como validadas y no cuadraban con lo que "Rechazar lote" anuncia
    // que va a tocar. Se mira el historial, no exportBatchId: al corregir una
    // factura exportada el puntero se pone a null y sigue estando en A3.
    const isExported = inv.status === "EXPORTED"
      || (inv.status === "VALIDATED" && inv.exportBatchItems.length > 0);
    if (isExported) g.exported++;
    else if (inv.status === "VALIDATED") g.validated++;
    else if (inv.status === "REJECTED") g.rejected++;
    else if (inv.status === "NEEDS_ATTENTION" || inv.status === "OCR_ERROR") {
      g.attentionCount++;
      if (inv.status === "OCR_ERROR") g.ocrError++;
      if (!g.firstPendingId) g.firstPendingId = inv.id;
    }
    else if (inv.status === "PENDING_REVIEW") {
      if (hasOpenIssue) g.attentionCount++;
      else g.cleanCount++;
      if (!g.firstPendingId) g.firstPendingId = inv.id;
    }
    else {
      // UPLOADED / ANALYZING / ANALYZED
      g.processingCount++;
      if (inv.status === "UPLOADED" || inv.status === "ANALYZING") g.ocrRunning++;
    }

    if (isBatchRejectable(inv)) {
      g.rejectable++;
      if (inv.status === "VALIDATED") g.rejectableValidated++;
    }
  }

  const groups = Array.from(groupMap.values());

  // Media historica de duracion OCR de la firma para la ETA. Fallback 10s.
  const anyProcessing = groups.some((g) => g.ocrRunning > 0);
  let avgOcrSec = 10;
  if (anyProcessing && firmId) {
    const agg = await prisma.invoiceExtraction.aggregate({
      where: {
        ocrDurationMs: { not: null, gt: 0 },
        invoice: { client: { advisoryFirmId: firmId } },
      },
      _avg: { ocrDurationMs: true },
    });
    if (agg._avg.ocrDurationMs) {
      avgOcrSec = Math.max(1, Math.round(agg._avg.ocrDurationMs / 1000));
    }
  }

  // Cierre de periodos: para pintar "cerrado" y poder filtrar por estado.
  const closures = groups.length
    ? await prisma.periodClosure.findMany({
        where: {
          OR: groups.map((g) => ({
            clientId: g.clientId,
            month: g.periodMonth,
            year: g.periodYear,
          })),
        },
        select: { clientId: true, month: true, year: true, reopenedAt: true },
      })
    : [];
  const closedSet = new Set(
    closures
      .filter((c) => !c.reopenedAt)
      .map((c) => `${c.clientId}-${c.year}-${c.month}`),
  );

  // Filtro de estado (por defecto "pendientes": oculta completados y cerrados).
  const visibleGroups = groups.filter((g) => {
    const allDone = g.validated + g.rejected + g.exported === g.total;
    const closed = closedSet.has(`${g.clientId}-${g.periodYear}-${g.periodMonth}`);
    if (estado === "todos") return true;
    if (estado === "cerrados") return closed;
    if (estado === "por_cerrar") return !closed && allDone;
    return !closed && !allDone; // pendientes
  });
  const hiddenCount = groups.length - visibleGroups.length;
  const hiddenPlural = hiddenCount !== 1 ? "s" : "";

  const verTodosHref = listHref("todos");

  // Agrupar los lotes visibles por cliente para la vista en acordeón.
  const clientGroupsMap = new Map<string, {
    clientId: string; clientName: string; clientCif: string;
    lotes: typeof visibleGroups; attentionSum: number; invoiceSum: number; allDone: boolean;
  }>();
  for (const g of visibleGroups) {
    let cg = clientGroupsMap.get(g.clientId);
    if (!cg) {
      cg = { clientId: g.clientId, clientName: g.clientName, clientCif: g.clientCif, lotes: [], attentionSum: 0, invoiceSum: 0, allDone: true };
      clientGroupsMap.set(g.clientId, cg);
    }
    cg.lotes.push(g);
    cg.attentionSum += g.attentionCount;
    cg.invoiceSum += g.total;
    if (g.validated + g.rejected + g.exported !== g.total) cg.allDone = false;
  }
  const clientGroups = Array.from(clientGroupsMap.values());
  clientGroups.sort((a, b) =>
    a.attentionSum !== b.attentionSum ? b.attentionSum - a.attentionSum : a.clientName.localeCompare(b.clientName),
  );
  // Con un solo cliente (p. ej. filtrando por cliente) la seccion
  // sale siempre abierta, sin mirar lo guardado: un plegado de otra visita
  // dejaba la unica fila cerrada. La key cambia para remontarla al pasar de
  // una vista a otra (cambiar los search params no la remonta).
  const singleClient = clientGroups.length === 1;

  return (
    <div>
      {anyProcessing && <AutoRefresh intervalMs={5000} />}
      <PageHeader
        title="Lotes de facturas"
        description="Facturas agrupadas por cliente y periodo"
      />

      <BatchFilters clients={clientOptions} basePath={basePath} />

      {/* Tres vacios distintos: sin facturas, sin nada pendiente (con el
          filtro por defecto) y sin resultados para los filtros elegidos. */}
      {groups.length === 0 && !hasFilters ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes"
          description="Cuando se suban facturas, los lotes aparecerán aquí agrupados por cliente y periodo."
        />
      ) : visibleGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-[13px] text-slate-500">
          {!hasFilters && estado === "pendientes" ? (
            <>
              {`No queda ningún lote pendiente. ${hiddenCount} lote${hiddenPlural} completado${hiddenPlural} o cerrado${hiddenPlural}: `}
              <Link href={verTodosHref} className="font-medium text-blue-600 hover:underline">
                Ver todos
              </Link>
            </>
          ) : (
            <>
              Ningún lote con estos filtros.{" "}
              {hiddenCount > 0 && (
                <>
                  <Link href={verTodosHref} className="font-medium text-blue-600 hover:underline">
                    Ver todos ({groups.length})
                  </Link>
                  {" · "}
                </>
              )}
              <Link href={basePath} className="font-medium text-blue-600 hover:underline">
                Quitar filtros
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
        <div className="space-y-3">
          {clientGroups.map((cg) => (
            <ClientAccordionSection
              key={singleClient ? `solo-${cg.clientId}` : cg.clientId}
              name={cg.clientName}
              cif={cg.clientCif}
              loteCount={cg.lotes.length}
              invoiceCount={cg.invoiceSum}
              attentionCount={cg.attentionSum}
              allDone={cg.allDone}
              defaultOpen={singleClient || cg.attentionSum > 0}
              storageKey={singleClient ? undefined : cg.clientId}
            >
          {cg.lotes.map((g) => {
            // REJECTED tambien cuenta como trabajo resuelto: el gestor ya
            // decidio que no entra en los libros. Incluirlo refleja el esfuerzo real.
            const done = g.validated + g.rejected + g.exported;
            const pct = completionPercent({
              total: g.total,
              validated: g.validated,
              rejected: g.rejected,
              exported: g.exported,
            });
            const allDone = done === g.total;
            const closed = closedSet.has(`${g.clientId}-${g.periodYear}-${g.periodMonth}`);
            const hasWork = g.attentionCount > 0 || g.cleanCount > 0 || g.processingCount > 0;

            return (
              <div
                key={`${g.clientId}-${g.periodYear}-${g.periodMonth}-${g.periodType}-${g.type}`}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2 className="text-[15px] font-semibold text-slate-900 truncate">
                        {g.clientName}
                      </h2>
                      <Badge variant={g.type === "PURCHASE" ? "blue" : "purple"}>
                        {g.type === "PURCHASE" ? "Recibidas" : "Emitidas"}
                      </Badge>
                      {closed ? (
                        <Badge variant="slate">Periodo cerrado</Badge>
                      ) : allDone ? (
                        <Badge variant="green">Completado</Badge>
                      ) : hasWork ? (
                        <Badge variant={g.attentionCount > 0 ? "yellow" : "blue"}>
                          {g.attentionCount > 0 ? "Con incidencias" : "En proceso"}
                        </Badge>
                      ) : null}
                      {g.ocrError > 0 && (
                        <Badge variant="red">
                          {g.ocrError} error{g.ocrError !== 1 ? "es" : ""} OCR
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-slate-400">
                      {g.clientCif} · {periodLabel(g.periodType, g.periodMonth, g.periodYear)} · {g.total} factura{g.total !== 1 ? "s" : ""}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 flex-shrink-0 justify-end">
                    {g.firstPendingId && (
                      <Link
                        // Sin bucket (= todas): la cola pasa por las que tienen
                        // incidencias y por las listas, y el numero del boton
                        // es el de facturas que va a recorrer.
                        href={reviewHref(g.firstPendingId, { back: thisListHref })}
                        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 transition-colors"
                      >
                        <PenLine className="h-3.5 w-3.5" />
                        Revisar ({g.attentionCount + g.cleanCount})
                      </Link>
                    )}
                    <Link
                      href={`/dashboard/admin/invoices?clientId=${g.clientId}&month=${g.periodMonth}&year=${g.periodYear}&type=${g.type}`}
                      className="flex items-center gap-1 text-[12px] font-medium text-slate-500 hover:text-slate-700"
                    >
                      Ver todas <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12px] text-slate-500">{pct}% procesado</span>
                    <span className="text-[12px] text-slate-400">{done}/{g.total}</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div className="flex h-full">
                      {g.exported > 0 && (
                        <div
                          className="h-full bg-slate-400 transition-all"
                          style={{ width: `${(g.exported / g.total) * 100}%` }}
                        />
                      )}
                      {g.validated > 0 && (
                        <div
                          className="h-full bg-green-500 transition-all"
                          style={{ width: `${(g.validated / g.total) * 100}%` }}
                        />
                      )}
                      {g.rejected > 0 && (
                        <div
                          className="h-full bg-red-400 transition-all"
                          style={{ width: `${(g.rejected / g.total) * 100}%` }}
                        />
                      )}
                      {g.attentionCount > 0 && (
                        <div
                          className="h-full bg-amber-400 transition-all"
                          style={{ width: `${(g.attentionCount / g.total) * 100}%` }}
                        />
                      )}
                      {g.cleanCount > 0 && (
                        <div
                          className="h-full bg-blue-400 transition-all"
                          style={{ width: `${(g.cleanCount / g.total) * 100}%` }}
                        />
                      )}
                      {g.processingCount > 0 && (
                        <div
                          className="h-full bg-slate-300 transition-all"
                          style={{ width: `${(g.processingCount / g.total) * 100}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Indicador de OCR en curso (uploaded + analyzing). Solo
                    se muestra mientras quedan facturas analizandose. */}
                {g.ocrRunning > 0 && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
                    <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                    <span>
                      {g.ocrRunning} en análisis OCR — media {avgOcrSec}s por factura
                      {g.ocrRunning > 1 && (
                        <span className="text-blue-500">{" "}(≈{g.ocrRunning * avgOcrSec}s en cola)</span>
                      )}
                    </span>
                  </div>
                )}

                {/* Status pills */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    { label: "Con incidencias",     count: g.attentionCount,   color: "bg-amber-50 text-amber-700" },
                    { label: "Listas para validar", count: g.cleanCount,       color: "bg-blue-50 text-blue-700" },
                    { label: "En análisis",         count: g.processingCount,  color: "bg-slate-100 text-slate-500" },
                    { label: "Validadas",           count: g.validated,        color: "bg-green-50 text-green-700" },
                    { label: "Rechazadas",          count: g.rejected,         color: "bg-red-50 text-red-600" },
                    { label: "Exportadas",          count: g.exported,         color: "bg-slate-100 text-slate-500" },
                  ].filter((s) => s.count > 0).map(({ label, count, color }) => (
                    <span
                      key={label}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${color}`}
                    >
                      {count} {label}
                    </span>
                  ))}
                </div>

                {/* Rechazar el lote completo (subido por error, contabilizado
                    por fuera...). El cierre de periodo del admin se hace en
                    su pantalla de cierres, por eso aqui no se ofrece. */}
                {!closed && (
                  <BatchActions
                    clientId={g.clientId}
                    month={g.periodMonth}
                    year={g.periodYear}
                    type={g.type}
                    periodType={g.periodType}
                    readyToClose={false}
                    alreadyClosed={false}
                    rejectableCount={g.rejectable}
                    validatedCount={g.rejectableValidated}
                  />
                )}
              </div>
            );
          })}
            </ClientAccordionSection>
          ))}
        </div>
        {hiddenCount > 0 && estado === "pendientes" && (
          <p className="mt-3 text-center text-[12px] text-slate-400">
            {`${hiddenCount} lote${hiddenPlural} completado${hiddenPlural} o cerrado${hiddenPlural} no se muestra${hiddenCount !== 1 ? "n" : ""}. `}
            <Link href={verTodosHref} className="font-medium text-blue-600 hover:underline">Ver todos</Link>
          </p>
        )}
        </>
      )}
    </div>
  );
}
