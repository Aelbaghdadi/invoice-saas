import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, ArrowRight, PenLine, Loader2, Download,
} from "lucide-react";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { completionPercent } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";
import { exportPageHref } from "@/lib/exportPage";
import { exportReadiness } from "@/lib/exportReadiness";
import { reviewHref } from "@/lib/reviewNavigation";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { BatchFilters } from "@/components/batch/BatchFilters";
import { ClientAccordionSection } from "@/components/batch/ClientAccordionSection";
import { BatchWindowNote } from "@/components/batch/BatchWindowNote";
import { batchKey, batchWindowWhere, groupBatches, loadBatchRows, type BatchGroup } from "@/lib/batchGroups";
import { BatchActions } from "@/app/dashboard/worker/batch/BatchActions";

// La pagina muestra estados de OCR en curso — la marcamos dynamic para
// que el conteo no quede cacheado entre cargas.
export const dynamic = "force-dynamic";

// Mismos buckets y pildoras que la pantalla de lotes del gestor: el mismo
// lote se describia distinto segun el rol. El admin tiene un solo boton,
// "Revisar (n)", que recorre todas las pendientes (incidencias y listas); su
// numero es el de la cola: antes contaba facturas aun en OCR (que no estan
// en ella) y no las de Error OCR (que si).
type AdminBatchGroup = BatchGroup & {
  /** Lo que se llevaria «Exportar» (exportReadiness): lo que se marcaria. */
  pendingExport: number;
  /** Validadas sin lote que no van al Excel hasta corregirlas (bloqueantes). */
  blockedExport: number;
};

export default async function BatchPage({
  searchParams,
}: {
  searchParams?: Promise<{ clientId?: string; year?: string; month?: string; type?: string; estado?: string; historico?: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  // Sin asesoria no hay lotes que ver: con el filtro a undefined, Prisma no
  // filtraba y salian los de todas.
  const firmId = session.user.advisoryFirmId;
  if (!firmId) redirect("/login");

  // Filtros (URL): cliente / año / mes / tipo / estado.
  const sp = (await searchParams) ?? {};
  const estado = sp.estado ?? "pendientes";
  const yearNum = sp.year ? parseInt(sp.year, 10) : null;
  const monthNum = sp.month ? parseInt(sp.month, 10) : null;
  const typeParam = sp.type === "PURCHASE" || sp.type === "SALE" ? sp.type : null;

  // Clientes de la firma para el desplegable de filtros.
  const clientOptions = await prisma.client.findMany({
    where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true, name: true, cif: true },
    orderBy: { name: "asc" },
  });
  const requestedClient =
    sp.clientId && clientOptions.some((c) => c.id === sp.clientId) ? sp.clientId : null;
  const showHistory = sp.historico === "1";
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
    if (showHistory) p.set("historico", "1");
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const thisListHref = listHref(estado);
  // El mismo listado con la ventana al reves (todo el historico o lo reciente).
  const historyToggleHref = (() => {
    const url = new URL(thisListHref, "http://x");
    if (showHistory) url.searchParams.delete("historico");
    else url.searchParams.set("historico", "1");
    return `${url.pathname}${url.search}`;
  })();

  // Solo las columnas que se pintan, y por defecto la ventana reciente
  // (F-030): antes se leia el historico entero en cada carga.
  const baseWhere: Prisma.InvoiceWhereInput = {
    // Excluir el buzón "Sin clasificar" (sus facturas son PENDING_ROUTING):
    // no es un cliente real, no debe aparecer como un lote más.
    client: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    ...(requestedClient ? { clientId: requestedClient } : {}),
    ...(yearNum ? { periodYear: yearNum } : {}),
    ...(monthNum ? { periodMonth: monthNum } : {}),
    ...(typeParam ? { type: typeParam } : {}),
  };
  // Con año elegido o «ver todo el histórico», sin ventana.
  const windowed = !yearNum && !showHistory;
  const invoices = await loadBatchRows(windowed ? await batchWindowWhere(baseWhere) : baseWhere);

  // Lo que se llevaria la siguiente exportacion, con su misma decision
  // (partitionA3Exportable): sin las que el Excel deja fuera para siempre, y
  // las bloqueantes aparte, que hay que corregir antes.
  const readiness = await exportReadiness(
    invoices.filter((inv) => inv.status === "VALIDATED" && inv.exportBatchId == null).map((inv) => inv.id),
    firmId,
  );

  const clientsById = new Map(clientOptions.map((c) => [c.id, { name: c.name, cif: c.cif }]));
  const exportCounts = new Map<string, { pendingExport: number; blockedExport: number }>();
  for (const inv of invoices) {
    if (!readiness.exportable.has(inv.id) && !readiness.blocked.has(inv.id)) continue;
    const counts = exportCounts.get(batchKey(inv)) ?? { pendingExport: 0, blockedExport: 0 };
    if (readiness.exportable.has(inv.id)) counts.pendingExport++;
    else counts.blockedExport++;
    exportCounts.set(batchKey(inv), counts);
  }
  const groups: AdminBatchGroup[] = groupBatches(invoices, clientsById).map((g) => ({
    ...g,
    ...(exportCounts.get(batchKey(g)) ?? { pendingExport: 0, blockedExport: 0 }),
  }));

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
    // Pendientes: por revisar, o terminado pero sin llevar a A3 (F-041).
    return (!closed && !allDone) || (allDone && (g.pendingExport > 0 || g.blockedExport > 0));
  });
  const hiddenCount = groups.length - visibleGroups.length;
  const hiddenPlural = hiddenCount !== 1 ? "s" : "";

  const verTodosHref = listHref("todos");

  // Agrupar los lotes visibles por cliente para la vista en acordeón.
  const clientGroupsMap = new Map<string, {
    clientId: string; clientName: string; clientCif: string;
    lotes: typeof visibleGroups; attentionSum: number; invoiceSum: number; allDone: boolean;
    /** Lotes terminados con algo por exportar. */
    readySum: number;
  }>();
  for (const g of visibleGroups) {
    let cg = clientGroupsMap.get(g.clientId);
    if (!cg) {
      cg = { clientId: g.clientId, clientName: g.clientName, clientCif: g.clientCif, lotes: [], attentionSum: 0, invoiceSum: 0, allDone: true, readySum: 0 };
      clientGroupsMap.set(g.clientId, cg);
    }
    cg.lotes.push(g);
    cg.attentionSum += g.attentionCount;
    cg.invoiceSum += g.total;
    if (g.validated + g.rejected + g.exported !== g.total) cg.allDone = false;
    else if (g.pendingExport > 0) cg.readySum++;
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
      {!yearNum && <BatchWindowNote showHistory={showHistory} toggleHref={historyToggleHref} />}

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
              readyCount={cg.readySum}
              defaultOpen={singleClient || cg.attentionSum > 0 || cg.readySum > 0}
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
                      {allDone && g.pendingExport > 0 && (
                        <Badge variant="blue">Listo para exportar</Badge>
                      )}
                      {g.blockedExport > 0 && (
                        <Badge variant="yellow">
                          {g.blockedExport} por corregir antes de exportar
                        </Badge>
                      )}
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
                    {g.pendingExport > 0 && (
                      <Link
                        href={exportPageHref({ clientId: g.clientId, periodType: g.periodType, month: g.periodMonth, year: g.periodYear, type: g.type })}
                        className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Exportar ({g.pendingExport})
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
