import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, AlertTriangle, PenLine, ArrowRight, CheckCircle2, Loader2,
} from "lucide-react";
import Link from "next/link";
import type { InvoiceType, PeriodType } from "@prisma/client";
import { completionPercent } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";
import { BatchActions } from "./BatchActions";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { BatchFilters } from "@/components/batch/BatchFilters";
import { ClientAccordionSection } from "@/components/batch/ClientAccordionSection";

// Esta pagina muta visualmente cada vez que avanza el OCR de fondo —
// la marcamos dynamic para que no quede cacheada entre cargas.
export const dynamic = "force-dynamic";

type BatchGroup = {
  clientId: string;
  clientName: string;
  clientCif: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  type: InvoiceType;
  total: number;
  // Buckets operativos (alineados con reviewQueue.ts):
  attentionCount: number;     // NEEDS_ATTENTION + OCR_ERROR + PENDING_REVIEW con issue OPEN
  cleanCount: number;         // PENDING_REVIEW sin issues
  processingCount: number;    // UPLOADED + ANALYZING + ANALYZED (legacy)
  validated: number;
  rejected: number;
  exported: number;
  ocrError: number;
  firstAttentionId: string | null;
  firstCleanId: string | null;
};

export default async function WorkerBatchPage({
  searchParams,
}: {
  searchParams?: Promise<{ clientId?: string; year?: string; month?: string; type?: string; estado?: string }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");

  // ADMIN ve los lotes de toda su firma; WORKER solo los de sus clientes.
  const clientIds = await getAccessibleClientIds(session).catch(() => [] as string[]);

  if (clientIds.length === 0) {
    return (
      <div>
        <PageHeader
          title="Lotes de facturas"
          description="Facturas pendientes de revisión agrupadas por cliente y periodo"
        />
        <EmptyState
          icon={Layers}
          title="Sin clientes asignados"
          description="Contacta con tu administrador para que te asigne clientes."
        />
      </div>
    );
  }

  // Filtros (URL): cliente / año / mes / tipo / estado. El cliente, año,
  // mes y tipo se aplican en la query; el estado tras agrupar.
  const sp = (await searchParams) ?? {};
  const estado = sp.estado ?? "pendientes";
  const requestedClient = sp.clientId && clientIds.includes(sp.clientId) ? sp.clientId : null;
  const yearNum = sp.year ? parseInt(sp.year, 10) : null;
  const monthNum = sp.month ? parseInt(sp.month, 10) : null;
  const typeParam = sp.type === "PURCHASE" || sp.type === "SALE" ? sp.type : null;

  // Clientes para el desplegable de filtros (los asignados al gestor).
  const clientOptions = await prisma.client.findMany({
    where: { id: { in: clientIds }, isUnclassifiedBucket: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  // Cargamos facturas + issues abiertas para decidir buckets sin 2ª query.
  const invoices = await prisma.invoice.findMany({
    where: {
      clientId: requestedClient ? requestedClient : { in: clientIds },
      ...(yearNum ? { periodYear: yearNum } : {}),
      ...(monthNum ? { periodMonth: monthNum } : {}),
      ...(typeParam ? { type: typeParam } : {}),
    },
    include: {
      client: { select: { id: true, name: true, cif: true } },
      issues: { where: { status: "OPEN" }, select: { id: true } },
    },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { createdAt: "asc" }],
  });

  // Group by client + period + type
  const groupMap = new Map<string, BatchGroup>();

  for (const inv of invoices) {
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
        validated: 0,
        rejected: 0,
        exported: 0,
        ocrError: 0,
        firstAttentionId: null,
        firstCleanId: null,
      };
      groupMap.set(key, g);
    }
    g.total++;
    const hasOpenIssue = inv.issues.length > 0;

    // Clasificacion en buckets. Prioridad: terminal > atencion > clean > processing.
    if (inv.status === "VALIDATED") g.validated++;
    else if (inv.status === "REJECTED") g.rejected++;
    else if (inv.status === "EXPORTED") g.exported++;
    else if (inv.status === "NEEDS_ATTENTION" || inv.status === "OCR_ERROR") {
      g.attentionCount++;
      if (inv.status === "OCR_ERROR") g.ocrError++;
      if (!g.firstAttentionId) g.firstAttentionId = inv.id;
    }
    else if (inv.status === "PENDING_REVIEW") {
      if (hasOpenIssue) {
        g.attentionCount++;
        if (!g.firstAttentionId) g.firstAttentionId = inv.id;
      } else {
        g.cleanCount++;
        if (!g.firstCleanId) g.firstCleanId = inv.id;
      }
    }
    else {
      // UPLOADED / ANALYZING / ANALYZED
      g.processingCount++;
    }
  }

  const groups = Array.from(groupMap.values());

  // Media historica de duracion OCR a nivel de firma. La usamos para
  // dar una ETA decente en los lotes con facturas analizandose. Si no
  // hay historial todavia, fallback a 10s.
  const anyProcessing = Array.from(groupMap.values()).some((g) => g.processingCount > 0);
  let avgOcrSec = 10;
  if (anyProcessing && session.user.advisoryFirmId) {
    const agg = await prisma.invoiceExtraction.aggregate({
      where: {
        ocrDurationMs: { not: null, gt: 0 },
        invoice: { client: { advisoryFirmId: session.user.advisoryFirmId } },
      },
      _avg: { ocrDurationMs: true },
    });
    if (agg._avg.ocrDurationMs) {
      avgOcrSec = Math.max(1, Math.round(agg._avg.ocrDurationMs / 1000));
    }
  }

  // Cierre de periodos: consultamos los que coinciden con cualquiera
  // de los lotes, asi sabemos cuales pintar como "cerrado".
  const closureKeys = groups.map((g) => ({
    clientId: g.clientId,
    month: g.periodMonth,
    year: g.periodYear,
  }));
  const closures = closureKeys.length
    ? await prisma.periodClosure.findMany({
        where: {
          OR: closureKeys.map((k) => ({
            clientId: k.clientId,
            month: k.month,
            year: k.year,
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

  // Para saber si un lote puede "cerrar periodo" hay que mirar que todo
  // el periodo (no solo ese tipo) este done. Calculamos pendientes por
  // (clientId, month, year) en total.
  const pendingByPeriod = new Map<string, number>();
  for (const inv of invoices) {
    const key = `${inv.clientId}-${inv.periodYear}-${inv.periodMonth}`;
    const pending =
      inv.status !== "VALIDATED" &&
      inv.status !== "REJECTED" &&
      inv.status !== "EXPORTED";
    if (pending) {
      pendingByPeriod.set(key, (pendingByPeriod.get(key) ?? 0) + 1);
    } else if (!pendingByPeriod.has(key)) {
      pendingByPeriod.set(key, 0);
    }
  }


  // Ordenar: primero los que tienen incidencias (mas urgentes), luego los
  // que tienen clean listas, y al final los ya cerrados.
  groups.sort((a, b) => {
    const aClosed = closedSet.has(`${a.clientId}-${a.periodYear}-${a.periodMonth}`);
    const bClosed = closedSet.has(`${b.clientId}-${b.periodYear}-${b.periodMonth}`);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.cleanCount !== b.cleanCount) return b.cleanCount - a.cleanCount;
    return `${b.periodYear}-${b.periodMonth}`.localeCompare(`${a.periodYear}-${a.periodMonth}`);
  });

  // Filtro de estado (por defecto "pendientes": oculta completados y cerrados).
  // "por_cerrar" = el tipo está completo pero el periodo sigue abierto.
  const visibleGroups = groups.filter((g) => {
    const allDone = g.validated + g.rejected + g.exported === g.total;
    const closed = closedSet.has(`${g.clientId}-${g.periodYear}-${g.periodMonth}`);
    if (estado === "todos") return true;
    if (estado === "cerrados") return closed;
    if (estado === "por_cerrar") return !closed && allDone;
    return !closed && !allDone; // pendientes
  });
  const hiddenCount = groups.length - visibleGroups.length;

  // "Ver todos" conserva los filtros activos y solo cambia el estado.
  const verTodosParams = new URLSearchParams();
  if (requestedClient) verTodosParams.set("clientId", requestedClient);
  if (yearNum) verTodosParams.set("year", String(yearNum));
  if (monthNum) verTodosParams.set("month", String(monthNum));
  if (typeParam) verTodosParams.set("type", typeParam);
  verTodosParams.set("estado", "todos");
  const verTodosHref = `/dashboard/worker/batch?${verTodosParams.toString()}`;

  // Agrupar los lotes visibles por cliente para la vista en acordeón: la
  // pantalla muestra los clientes con lote activo y, al pulsar, sus lotes.
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

  return (
    <div>
      {/* Auto-refresh cada 5s si hay alguna factura en analisis OCR,
          para que las cards reflejen el progreso sin tocar F5. */}
      {anyProcessing && <AutoRefresh intervalMs={5000} />}
      <PageHeader
        title="Lotes de facturas"
        description="Sesiones de trabajo agrupadas por cliente y periodo — empieza por los que tienen incidencias"
      />

      <BatchFilters clients={clientOptions} basePath="/dashboard/worker/batch" />

      {groups.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes pendientes"
          description="Tus clientes no tienen facturas para procesar."
        />
      ) : visibleGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-[13px] text-slate-500">
          No hay lotes que coincidan con este filtro.{" "}
          {hiddenCount > 0 && (
            <Link href={verTodosHref} className="font-medium text-blue-600 hover:underline">
              Ver todos ({groups.length})
            </Link>
          )}
        </div>
      ) : (
        <>
        <div className="space-y-3">
          {clientGroups.map((cg) => (
            <ClientAccordionSection
              key={cg.clientId}
              name={cg.clientName}
              cif={cg.clientCif}
              loteCount={cg.lotes.length}
              invoiceCount={cg.invoiceSum}
              attentionCount={cg.attentionSum}
              allDone={cg.allDone}
              defaultOpen={clientGroups.length === 1}
            >
          {cg.lotes.map((g) => {
            const done = g.validated + g.rejected + g.exported;
            const pct = completionPercent({
              total: g.total,
              validated: g.validated,
              rejected: g.rejected,
              exported: g.exported,
            });
            const periodKey = `${g.clientId}-${g.periodYear}-${g.periodMonth}`;
            const closed = closedSet.has(periodKey);
            const periodPending = pendingByPeriod.get(periodKey) ?? 0;
            const readyToClose = periodPending === 0 && !closed;
            const allDone = done === g.total;
            const hasWork = g.attentionCount > 0 || g.cleanCount > 0 || g.processingCount > 0;

            return (
              <div
                key={`${g.clientId}-${g.periodYear}-${g.periodMonth}-${g.periodType}-${g.type}`}
                className={
                  "rounded-xl border bg-white p-5 shadow-sm " +
                  (closed
                    ? "border-slate-200 opacity-75"
                    : g.attentionCount > 0
                      ? "border-amber-200"
                      : "border-slate-200")
                }
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
                          {g.attentionCount > 0 ? "Requiere accion" : "En proceso"}
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
                    {g.firstAttentionId && (
                      <Link
                        href={`/dashboard/worker/review/${g.firstAttentionId}?bucket=attention`}
                        prefetch
                        className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-600 transition-colors"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Resolver incidencias ({g.attentionCount})
                      </Link>
                    )}
                    {g.firstCleanId && (
                      <Link
                        href={`/dashboard/worker/review/${g.firstCleanId}?bucket=clean`}
                        prefetch
                        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 transition-colors"
                      >
                        <PenLine className="h-3.5 w-3.5" />
                        Validar listas ({g.cleanCount})
                      </Link>
                    )}
                    <Link
                      href={`/dashboard/worker/invoices?clientId=${g.clientId}&month=${g.periodMonth}&year=${g.periodYear}&type=${g.type}&bucket=all`}
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

                {/* Indicador de OCR en curso. Solo aparece si quedan
                    facturas analizandose. Estima total = N x media. */}
                {g.processingCount > 0 && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
                    <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                    <span>
                      {g.processingCount} en análisis OCR — media {avgOcrSec}s por factura
                      {g.processingCount > 1 && (
                        <span className="text-blue-500">{" "}(≈{g.processingCount * avgOcrSec}s en cola)</span>
                      )}
                    </span>
                  </div>
                )}

                {/* Status pills */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    { label: "Incidencias",   count: g.attentionCount,   color: "bg-amber-50 text-amber-700" },
                    { label: "Listas",        count: g.cleanCount,       color: "bg-blue-50 text-blue-700" },
                    { label: "Procesando",    count: g.processingCount,  color: "bg-slate-100 text-slate-500" },
                    { label: "Validadas",     count: g.validated,        color: "bg-green-50 text-green-700" },
                    { label: "Rechazadas",    count: g.rejected,         color: "bg-red-50 text-red-600" },
                    { label: "Exportadas",    count: g.exported,         color: "bg-slate-100 text-slate-500" },
                  ].filter((s) => s.count > 0).map(({ label, count, color }) => (
                    <span
                      key={label}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${color}`}
                    >
                      {count} {label}
                    </span>
                  ))}
                  {allDone && !closed && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" />
                      Tipo completo
                    </span>
                  )}
                </div>

                {/* Accion: cerrar periodo cuando todo esta validado. */}
                {!closed && readyToClose && (
                  <BatchActions
                    clientId={g.clientId}
                    month={g.periodMonth}
                    year={g.periodYear}
                    type={g.type}
                    readyToClose={readyToClose}
                    alreadyClosed={closed}
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
            {hiddenCount} lote{hiddenCount !== 1 ? "s" : ""} completado/cerrado oculto{hiddenCount !== 1 ? "s" : ""}.{" "}
            <Link href={verTodosHref} className="font-medium text-blue-600 hover:underline">Ver todos</Link>
          </p>
        )}
        </>
      )}
    </div>
  );
}
