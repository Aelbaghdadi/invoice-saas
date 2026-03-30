import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Layers, FileText, CheckCircle2, Clock, ArrowRight } from "lucide-react";
import Link from "next/link";

export default async function WorkerBatchPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const assignments = await prisma.workerClientAssignment
    .findMany({
      where: { workerId: session.user.id },
      include: {
        client: {
          include: { invoices: { orderBy: { createdAt: "desc" } } },
        },
      },
    })
    .catch(() => []);

  const clientsWithInvoices = assignments.filter(
    (a) => a.client.invoices.length > 0
  );

  return (
    <div>
      <PageHeader
        title="Lotes de facturas"
        description="Facturas pendientes de revisión agrupadas por cliente"
      />

      {clientsWithInvoices.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="Sin lotes pendientes"
          description="Tus clientes no tienen facturas para procesar."
        />
      ) : (
        <div className="space-y-4">
          {clientsWithInvoices.map(({ client }) => {
            const uploaded  = client.invoices.filter((i) => i.status === "UPLOADED").length;
            const analyzing = client.invoices.filter((i) => i.status === "ANALYZING").length;
            const analyzed  = client.invoices.filter((i) => i.status === "ANALYZED").length;
            const ocrError  = client.invoices.filter((i) => i.status === "OCR_ERROR").length;
            const validated = client.invoices.filter((i) => i.status === "VALIDATED").length;
            const rejected  = client.invoices.filter((i) => i.status === "REJECTED").length;
            const exported  = client.invoices.filter((i) => i.status === "EXPORTED").length;
            const total     = client.invoices.length;
            const pct       = total > 0 ? Math.round(((validated + exported) / total) * 100) : 0;

            return (
              <div
                key={client.id}
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-[15px] font-semibold text-slate-900">
                      {client.name}
                    </h2>
                    <p className="text-[12px] text-slate-400">
                      {client.cif} · {total} facturas en total
                    </p>
                  </div>
                  <Link
                    href={`/dashboard/worker/invoices?clientId=${client.id}`}
                    className="flex items-center gap-1 text-[13px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    Revisar lote <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[12px] text-slate-500">{pct}% procesado</span>
                    <span className="text-[12px] text-slate-400">
                      {validated + exported}/{total}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-7 gap-3">
                  {[
                    { label: "Subidas",    count: uploaded,  icon: FileText,     },
                    { label: "En OCR",     count: analyzing, icon: Clock,        },
                    { label: "Analizadas", count: analyzed,  icon: Clock,        },
                    { label: "Error OCR",  count: ocrError,  icon: FileText,     },
                    { label: "Validadas",  count: validated, icon: CheckCircle2, },
                    { label: "Rechazadas", count: rejected,  icon: FileText,     },
                    { label: "Exportadas", count: exported,  icon: Layers,       },
                  ].map(({ label, count, icon: Icon }) => (
                    <div
                      key={label}
                      className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                    >
                      <Icon
                        className={`h-4 w-4 flex-shrink-0 ${count > 0 ? "text-blue-500" : "text-slate-300"}`}
                      />
                      <div>
                        <p className="text-[15px] font-bold text-slate-800">{count}</p>
                        <p className="text-[11px] text-slate-400">{label}</p>
                      </div>
                    </div>
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
