import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { IssueActions } from "./IssueActions";

const TYPE_LABELS: Record<string, string> = {
  OCR_FAILED: "Error OCR",
  LOW_CONFIDENCE: "Baja confianza",
  POSSIBLE_DUPLICATE: "Posible duplicado",
  MATH_MISMATCH: "Error matematico",
  MANUAL: "Manual",
};

const TYPE_VARIANT: Record<string, "red" | "yellow" | "blue" | "slate"> = {
  OCR_FAILED: "red",
  LOW_CONFIDENCE: "yellow",
  POSSIBLE_DUPLICATE: "yellow",
  MATH_MISMATCH: "red",
  MANUAL: "blue",
};

const STATUS_VARIANT: Record<string, "green" | "slate" | "yellow"> = {
  OPEN: "yellow",
  RESOLVED: "green",
  DISMISSED: "slate",
};

export default async function WorkerIssuesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string }>;
}) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role))
    redirect("/login");

  const sp = await searchParams;
  const filterType = sp.type ?? "ALL";
  const filterStatus = sp.status ?? "OPEN";

  // Get worker's assigned client IDs
  let clientIds: string[] | undefined;
  if (session.user.role === "WORKER") {
    const assignments = await prisma.workerClientAssignment.findMany({
      where: { workerId: session.user.id },
      select: { clientId: true },
    });
    clientIds = assignments.map((a) => a.clientId);
  }

  const issues = await prisma.invoiceIssue.findMany({
    where: {
      ...(filterStatus !== "ALL" ? { status: filterStatus as "OPEN" | "RESOLVED" | "DISMISSED" } : {}),
      ...(filterType !== "ALL" ? { type: filterType as "OCR_FAILED" | "LOW_CONFIDENCE" | "POSSIBLE_DUPLICATE" | "MATH_MISMATCH" | "MANUAL" } : {}),
      invoice: clientIds ? { clientId: { in: clientIds } } : undefined,
    },
    include: {
      invoice: {
        select: { id: true, filename: true, invoiceNumber: true, client: { select: { name: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Incidencias</h1>
        <p className="text-sm text-slate-500">Incidencias detectadas en las facturas de tus clientes.</p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Estado:</label>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            {[
              { value: "OPEN", label: "Abiertas" },
              { value: "RESOLVED", label: "Resueltas" },
              { value: "DISMISSED", label: "Descartadas" },
              { value: "ALL", label: "Todas" },
            ].map((opt) => (
              <Link
                key={opt.value}
                href={`/dashboard/worker/issues?status=${opt.value}&type=${filterType}`}
                className={`px-3 py-1.5 text-xs font-medium transition ${
                  filterStatus === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Tipo:</label>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            {[
              { value: "ALL", label: "Todos" },
              { value: "OCR_FAILED", label: "OCR" },
              { value: "LOW_CONFIDENCE", label: "Confianza" },
              { value: "MATH_MISMATCH", label: "Matematico" },
              { value: "POSSIBLE_DUPLICATE", label: "Duplicado" },
              { value: "MANUAL", label: "Manual" },
            ].map((opt) => (
              <Link
                key={opt.value}
                href={`/dashboard/worker/issues?status=${filterStatus}&type=${opt.value}`}
                className={`px-3 py-1.5 text-xs font-medium transition ${
                  filterType === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Issues list */}
      {issues.length === 0 ? (
        <div className="rounded-xl border border-slate-100 bg-white px-6 py-12 text-center">
          <p className="text-sm text-slate-400">No hay incidencias con estos filtros.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-100 bg-white divide-y divide-slate-100">
          {issues.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between px-5 py-3.5">
              <div className="flex items-start gap-3 min-w-0">
                <Badge variant={TYPE_VARIANT[issue.type] ?? "slate"}>
                  {TYPE_LABELS[issue.type] ?? issue.type}
                </Badge>
                <div className="min-w-0">
                  <p className="text-[13px] text-slate-700 truncate">{issue.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Link
                      href={`/dashboard/worker/review/${issue.invoiceId}`}
                      className="text-[11px] text-blue-600 hover:underline truncate"
                    >
                      {issue.invoice.filename}
                    </Link>
                    <span className="text-[11px] text-slate-400">{issue.invoice.client?.name}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge variant={STATUS_VARIANT[issue.status] ?? "slate"}>
                  {issue.status === "OPEN" ? "Abierta" : issue.status === "RESOLVED" ? "Resuelta" : "Descartada"}
                </Badge>
                {issue.status === "OPEN" && <IssueActions issueId={issue.id} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
