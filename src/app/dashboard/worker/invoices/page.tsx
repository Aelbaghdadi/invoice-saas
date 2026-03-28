import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { FileText, PenLine } from "lucide-react";
import Link from "next/link";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",       variant: "blue" },
  ANALYZING: { label: "En análisis",  variant: "yellow" },
  VALIDATED: { label: "Validada",     variant: "green" },
  EXPORTED:  { label: "Exportada",    variant: "slate" },
};

export default async function WorkerInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ clientId?: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const { clientId } = await searchParams;

  // Get all client IDs assigned to this worker
  const assignments = await prisma.workerClientAssignment
    .findMany({ where: { workerId: session.user.id }, select: { clientId: true } })
    .catch(() => []);

  const allowedClientIds = assignments.map((a) => a.clientId);

  const invoices = await prisma.invoice
    .findMany({
      where: {
        clientId: clientId && allowedClientIds.includes(clientId)
          ? clientId
          : { in: allowedClientIds },
      },
      include: { client: true },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => []);

  return (
    <div>
      <PageHeader
        title="Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""}`}
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Sin facturas"
            description="No hay facturas disponibles para tus clientes asignados."
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
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <span className="max-w-[160px] truncate text-[13px] font-medium text-slate-700">
                          {inv.filename}
                        </span>
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
                      {(inv.status === "ANALYZING" || inv.status === "UPLOADED") && (
                        <Link
                          href={`/dashboard/worker/review/${inv.id}`}
                          className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-100"
                        >
                          <PenLine className="h-3.5 w-3.5" />
                          Revisar
                        </Link>
                      )}
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
