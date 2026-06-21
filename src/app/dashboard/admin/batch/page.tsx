import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, FileText, CheckCircle2, Clock, ArrowRight,
  AlertTriangle, Eye, Upload, Loader2,
} from "lucide-react";
import Link from "next/link";
import type { InvoiceType, PeriodType } from "@prisma/client";
import { PENDING_WORK, completionPercent } from "@/lib/invoiceStatuses";
import { periodLabel } from "@/lib/period";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { BatchFilters } from "@/components/batch/BatchFilters";
import { ClientAccordionSection } from "@/components/batch/ClientAccordionSection";

// La pagina muestra estados de OCR en curso — la marcamos dynamic para
// que el conteo no quede cacheado entre cargas.
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
  uploaded: number;
  analyzing: number;
  analyzed: number;
  pendingReview: number;
  needsAttention: number;
  ocrError: number;
  validated: number;
  rejected: number;
  exported: number;
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
    include: { client: { select: { id: true, name: true, cif: true } } },
    // createdAt asc para que `firstPendingId` sea la mas vieja del lote
    // y coincida con el orden de la cola de revision (que tambien usa
    // asc). Asi al pulsar "Revisar" entras por la 1 de N, no por la N.
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { createdAt: "asc" }],
  });

  // Group by client + period
  const groupMap = new Map<string, BatchGroup>();
  const pendingStatuses = new Set<string>(PENDING_WORK);

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
        uploaded: 0,
        analyzing: 0,
        analyzed: 0,
        pendingReview: 0,
        needsAttention: 0,
        ocrError: 0,
        validated: 0,
        rejected: 0,
        exported: 0,
        firstPendingId: null,
      };
      groupMap.set(key, g);
    }
    g.total++;
    switch (inv.status) {
      case "UPLOADED":         g.uploaded++; break;
      case "ANALYZING":        g.analyzing++; break;
      case "ANALYZED":         g.analyzed++; break;
      case "PENDING_REVIEW":   g.pendingReview++; break;
      case "NEEDS_ATTENTION":  g.needsAttention++; break;
      case "OCR_ERROR":        g.ocrError++; break;
      case "VALIDATED":        g.validated++; break;
      case "REJECTED":         g.rejected++; break;
      case "EXPORTED":         g.exported++; break;
    }
    if (!g.firstPendingId && pendingStatuses.has(inv.status)) {
      g.firstPendingId = inv.id;
    }
  }

  const groups = Array.from(groupMap.values());

  // Media historica de duracion OCR de la firma para la ETA. Fallback 10s.
  const anyProcessing = groups.some((g) => g.uploaded + g.analyzing > 0);
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

  const verTodosParams = new URLSearchParams();
  if (requestedClient) verTodosParams.set("clientId", requestedClient);
  if (yearNum) verTodosParams.set("year", String(yearNum));
  if (monthNum) verTodosParams.set("month", String(monthNum));
  if (typeParam) verTodosParams.set("type", typeParam);
  verTodosParams.set("estado", "todos");
  const verTodosHref = `/dashboard/admin/batch?${verTodosParams.toString()}`;

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
    cg.attentionSum += g.needsAttention;
    cg.invoiceSum += g.total;
    if (g.validated + g.rejected + g.exported !== g.total) cg.allDone = false;
  }
  const clientGroups = Array.from(clientGroupsMap.values());
  clientGroups.sort((a, b) =>
    a.attentionSum !== b.attentionSum ? b.attentionSum - a.attentionSum : a.clientName.localeCompare(b.clientName),
  );

  return (
    <div>
      {anyProcessing && <AutoRefresh intervalMs={5000} />}
      <PageHeader
        title="Lotes de facturas"
        description="Facturas agrupadas por cliente y periodo mensual"
      />

      <BatchFilters clients={clientOptions} basePath="/dashboard/admin/batch" />

      {groups.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes"
          description="Cuando se suban facturas, los lotes aparecerán aquí agrupados por cliente y mes."
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
            // REJECTED tambien cuenta como trabajo resuelto: el gestor ya
            // decidio que no entra en los libros. Incluirlo refleja el esfuerzo real.
            const done = g.validated + g.rejected + g.exported;
            const pct = completionPercent({
              total: g.total,
              validated: g.validated,
              rejected: g.rejected,
              exported: g.exported,
            });
            const pending = g.uploaded + g.analyzed + g.pendingReview + g.needsAttention;
            const allDone = done === g.total;
            const closed = closedSet.has(`${g.clientId}-${g.periodYear}-${g.periodMonth}`);
            const hasErrors = g.ocrError > 0;
            const hasIssues = g.needsAttention > 0;

            return (
              <div
                key={`${g.clientId}-${g.periodYear}-${g.periodMonth}-${g.periodType}-${g.type}`}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <h2 className="text-[15px] font-semibold text-slate-900 truncate">
                        {g.clientName}
                      </h2>
                      <Badge variant={g.type === "PURCHASE" ? "blue" : "purple"}>
                        {g.type === "PURCHASE" ? "Recibidas" : "Emitidas"}
                      </Badge>
                      {closed ? (
                        <Badge variant="slate">Periodo cerrado</Badge>
                      ) : (
                        <Badge variant={allDone ? "green" : pending > 0 ? "blue" : "slate"}>
                          {allDone ? "Completado" : pending > 0 ? "En proceso" : "Parcial"}
                        </Badge>
                      )}
                      {hasErrors && (
                        <Badge variant="red">
                          {g.ocrError} error{g.ocrError !== 1 ? "es" : ""} OCR
                        </Badge>
                      )}
                      {hasIssues && (
                        <Badge variant="yellow">
                          {g.needsAttention} con incidencias
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12px] text-slate-400">
                      {g.clientCif} · {periodLabel(g.periodType, g.periodMonth, g.periodYear)} · {g.total} factura{g.total !== 1 ? "s" : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {g.firstPendingId && (
                      <Link
                        // bucket=all para que la cola incluya todas las
                        // pendientes (clean + attention) y el contador
                        // X de N cuadre con `pending` mostrado al lado.
                        href={`/dashboard/worker/review/${g.firstPendingId}?bucket=all`}
                        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Revisar ({pending})
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
                      {(g.pendingReview + g.analyzed + g.needsAttention) > 0 && (
                        <div
                          className="h-full bg-blue-400 transition-all"
                          style={{ width: `${((g.pendingReview + g.analyzed + g.needsAttention) / g.total) * 100}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Indicador de OCR en curso (uploaded + analyzing). Solo
                    se muestra mientras quedan facturas analizandose. */}
                {(g.uploaded + g.analyzing) > 0 && (() => {
                  const inProgress = g.uploaded + g.analyzing;
                  return (
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                      <span>
                        {inProgress} en análisis OCR — media {avgOcrSec}s por factura
                        {inProgress > 1 && (
                          <span className="text-blue-500">{" "}(≈{inProgress * avgOcrSec}s en cola)</span>
                        )}
                      </span>
                    </div>
                  );
                })()}

                {/* Status pills */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    { label: "Pendientes",  count: g.uploaded,                            color: "bg-slate-100 text-slate-600" },
                    { label: "En OCR",       count: g.analyzing,                           color: "bg-yellow-50 text-yellow-700" },
                    { label: "Analizadas",   count: g.analyzed,                            color: "bg-yellow-50 text-yellow-700" },
                    { label: "Pte. revisión",count: g.pendingReview,                      color: "bg-blue-50 text-blue-700" },
                    { label: "Incidencias",  count: g.needsAttention,                     color: "bg-amber-50 text-amber-700" },
                    { label: "Error OCR",    count: g.ocrError,                            color: "bg-red-50 text-red-600" },
                    { label: "Validadas",    count: g.validated,                           color: "bg-green-50 text-green-700" },
                    { label: "Rechazadas",   count: g.rejected,                            color: "bg-red-50 text-red-600" },
                    { label: "Exportadas",   count: g.exported,                            color: "bg-slate-100 text-slate-500" },
                  ].filter((s) => s.count > 0).map(({ label, count, color }) => (
                    <span
                      key={label}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${color}`}
                    >
                      {count} {label}
                    </span>
                  ))}
                </div>
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
