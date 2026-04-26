import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, AlertTriangle, PenLine, ArrowRight, CheckCircle2,
} from "lucide-react";
import Link from "next/link";
import type { InvoiceType } from "@prisma/client";
import { completionPercent } from "@/lib/invoiceStatuses";
import { BatchActions } from "./BatchActions";

type BatchGroup = {
  clientId: string;
  clientName: string;
  clientCif: string;
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

export default async function WorkerBatchPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const assignments = await prisma.workerClientAssignment.findMany({
    where: { workerId: session.user.id },
    select: { clientId: true },
  });
  const clientIds = assignments.map((a) => a.clientId);

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

  // Cargamos facturas + issues abiertas + extractions para poder decidir
  // que va a que bucket sin una segunda query.
  const invoices = await prisma.invoice.findMany({
    where: { clientId: { in: clientIds } },
    include: {
      client: { select: { id: true, name: true, cif: true } },
      issues: { where: { status: "OPEN" }, select: { id: true } },
    },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { createdAt: "asc" }],
  });

  // Group by client + period + type
  const groupMap = new Map<string, BatchGroup>();

  for (const inv of invoices) {
    const key = `${inv.clientId}-${inv.periodYear}-${inv.periodMonth}-${inv.type}`;
    let g = groupMap.get(key);
    if (!g) {
      g = {
        clientId: inv.clientId,
        clientName: inv.client.name,
        clientCif: inv.client.cif,
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

  const monthName = (m: number) =>
    new Date(2000, m - 1).toLocaleString("es-ES", { month: "long" });

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

  return (
    <div>
      <PageHeader
        title="Lotes de facturas"
        description="Sesiones de trabajo agrupadas por cliente y periodo — empieza por los que tienen incidencias"
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes pendientes"
          description="Tus clientes no tienen facturas para procesar."
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
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
                key={`${g.clientId}-${g.periodYear}-${g.periodMonth}-${g.type}`}
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
                      {g.clientCif} · <span className="capitalize">{monthName(g.periodMonth)}</span> {g.periodYear} · {g.total} factura{g.total !== 1 ? "s" : ""}
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

                {/* Acciones masivas: auto-validar listas + cerrar periodo */}
                {!closed && (g.cleanCount > 0 || readyToClose) && (
                  <BatchActions
                    clientId={g.clientId}
                    month={g.periodMonth}
                    year={g.periodYear}
                    type={g.type}
                    cleanCount={g.cleanCount}
                    readyToClose={readyToClose}
                    alreadyClosed={closed}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
