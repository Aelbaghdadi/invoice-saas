import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import {
  Layers, FileText, CheckCircle2, Clock, ArrowRight,
  AlertTriangle, Eye, Upload,
} from "lucide-react";
import Link from "next/link";
import type { InvoiceType } from "@prisma/client";
import { PENDING_WORK, completionPercent } from "@/lib/invoiceStatuses";

type BatchGroup = {
  clientId: string;
  clientName: string;
  clientCif: string;
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

export default async function BatchPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const invoices = await prisma.invoice.findMany({
    where: { client: { advisoryFirmId: firmId } },
    include: { client: { select: { id: true, name: true, cif: true } } },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { createdAt: "desc" }],
  });

  // Group by client + period
  const groupMap = new Map<string, BatchGroup>();
  const pendingStatuses = new Set<string>(PENDING_WORK);

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

  const monthName = (m: number) =>
    new Date(2000, m - 1).toLocaleString("es-ES", { month: "long" });

  return (
    <div>
      <PageHeader
        title="Lotes de facturas"
        description="Facturas agrupadas por cliente y periodo mensual"
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes"
          description="Cuando se suban facturas, los lotes aparecerán aquí agrupados por cliente y mes."
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
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
            const hasErrors = g.ocrError > 0;
            const hasIssues = g.needsAttention > 0;

            return (
              <div
                key={`${g.clientId}-${g.periodYear}-${g.periodMonth}-${g.type}`}
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
                      <Badge variant={allDone ? "green" : pending > 0 ? "blue" : "slate"}>
                        {allDone ? "Completado" : pending > 0 ? "En proceso" : "Parcial"}
                      </Badge>
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
                      {g.clientCif} · <span className="capitalize">{monthName(g.periodMonth)}</span> {g.periodYear} · {g.total} factura{g.total !== 1 ? "s" : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {g.firstPendingId && (
                      <Link
                        href={`/dashboard/worker/review/${g.firstPendingId}`}
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
        </div>
      )}
    </div>
  );
}
