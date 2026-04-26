import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { FileText, PenLine, X, AlertTriangle } from "lucide-react";
import Link from "next/link";
import type { InvoiceType, Prisma } from "@prisma/client";
import { DuplicateRowActions } from "./DuplicateRowActions";

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
    return { ...base, status: { in: ["VALIDATED", "REJECTED", "EXPORTED"] } };
  }
  return base; // all
}

export default async function WorkerInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    clientId?: string;
    month?: string;
    year?: string;
    type?: string;
    bucket?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const params = await searchParams;
  const clientId = params.clientId;
  const monthFilter = params.month ? parseInt(params.month, 10) || undefined : undefined;
  const yearFilter = params.year ? parseInt(params.year, 10) || undefined : undefined;
  const typeFilter = params.type;
  const bucket = parseBucket(params.bucket);

  // Get all client IDs assigned to this worker
  const assignments = await prisma.workerClientAssignment
    .findMany({ where: { workerId: session.user.id }, select: { clientId: true } })
    .catch(() => []);

  const allowedClientIds = assignments.map((a) => a.clientId);
  const scopedClientId = clientId && allowedClientIds.includes(clientId) ? clientId : null;

  const baseWhere: Prisma.InvoiceWhereInput = {
    clientId: scopedClientId ?? { in: allowedClientIds },
    ...(monthFilter ? { periodMonth: monthFilter } : {}),
    ...(yearFilter ? { periodYear: yearFilter } : {}),
    ...(typeFilter ? { type: typeFilter as InvoiceType } : {}),
  };

  // Contadores por bucket (en paralelo). Asi el gestor ve de un vistazo
  // cuanto tiene en cada bandeja sin tener que cambiar de tab.
  const [countAttention, countClean, countDone, countAll] = await Promise.all([
    prisma.invoice.count({ where: whereForBucket("attention", baseWhere) }).catch(() => 0),
    prisma.invoice.count({ where: whereForBucket("clean", baseWhere) }).catch(() => 0),
    prisma.invoice.count({ where: whereForBucket("done", baseWhere) }).catch(() => 0),
    prisma.invoice.count({ where: baseWhere }).catch(() => 0),
  ]);

  const invoices = await prisma.invoice
    .findMany({
      where: whereForBucket(bucket, baseWhere),
      include: {
        client: true,
        issues: {
          where: { status: "OPEN" },
          select: { id: true, type: true, description: true },
        },
      },
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

  // Reconstruye la URL base manteniendo todos los filtros menos `bucket`,
  // para que al cambiar de tab se conserve el resto del contexto.
  const makeTabHref = (b: Bucket) => {
    const sp = new URLSearchParams();
    if (scopedClientId) sp.set("clientId", scopedClientId);
    if (monthFilter) sp.set("month", String(monthFilter));
    if (yearFilter) sp.set("year", String(yearFilter));
    if (typeFilter) sp.set("type", typeFilter);
    if (b !== "attention") sp.set("bucket", b); // attention es default
    const q = sp.toString();
    return q ? `/dashboard/worker/invoices?${q}` : "/dashboard/worker/invoices";
  };

  // Sufijo para enlaces a /review/[id] que preserva el bucket actual
  // (solo pasa clean/attention, que es lo que reviewQueue entiende).
  const reviewSuffix =
    bucket === "clean" || bucket === "attention" ? `?bucket=${bucket}` : "";

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
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""} en esta bandeja`}
      />

      {hasBatchFilter && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-700">
          <span className="text-blue-400">Filtrado por:</span>
          <span className="capitalize">{chipParts.join(" \u00B7 ")}</span>
          <Link
            href={bucket === "attention" ? "/dashboard/worker/invoices" : `/dashboard/worker/invoices?bucket=${bucket}`}
            className="ml-1 flex h-5 w-5 items-center justify-center rounded-full text-blue-400 hover:bg-blue-100 hover:text-blue-600"
            title="Quitar filtro"
          >
            <X className="h-3 w-3" />
          </Link>
        </div>
      )}

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

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={
              bucket === "attention"
                ? "Sin incidencias pendientes"
                : bucket === "clean"
                  ? "No hay facturas listas para validar"
                  : bucket === "done"
                    ? "Aún no hay facturas cerradas"
                    : "Sin facturas"
            }
            description={
              bucket === "attention"
                ? "Buenas noticias: ninguna factura requiere accion manual ahora mismo."
                : "No hay facturas disponibles con estos filtros."
            }
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
                          <span className="block max-w-[180px] truncate text-[13px] font-medium text-slate-700">
                            {inv.filename}
                          </span>
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
                      <div className="flex items-center justify-end gap-2">
                        {duplicateIssue && reviewable && (
                          <DuplicateRowActions invoiceId={inv.id} />
                        )}
                        {reviewable && (
                          <Link
                            href={`/dashboard/worker/review/${inv.id}${reviewSuffix}`}
                            className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-100"
                          >
                            <PenLine className="h-3.5 w-3.5" />
                            Revisar
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
      </div>
    </div>
  );
}
