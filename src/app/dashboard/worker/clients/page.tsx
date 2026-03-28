import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Building2, ArrowRight, FileText } from "lucide-react";
import Link from "next/link";

export default async function WorkerClientsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "WORKER") redirect("/login");

  const assignments = await prisma.workerClientAssignment
    .findMany({
      where: { workerId: session.user.id },
      include: {
        client: {
          include: {
            invoices: { orderBy: { createdAt: "desc" } },
          },
        },
      },
    })
    .catch(() => []);

  return (
    <div>
      <PageHeader
        title="Mis Clientes"
        description={`${assignments.length} cliente${assignments.length !== 1 ? "s" : ""} asignado${assignments.length !== 1 ? "s" : ""}`}
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {assignments.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Sin clientes asignados"
            description="El administrador te asignará clientes próximamente."
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {["Cliente", "CIF", "Facturas", "Pendientes", ""].map((h) => (
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
              {assignments.map(({ client }) => {
                const pending = client.invoices.filter((i) =>
                  ["UPLOADED", "ANALYZING"].includes(i.status)
                ).length;
                return (
                  <tr key={client.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-600">
                          {client.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-[13px] font-semibold text-slate-800">
                            {client.name}
                          </p>
                          <p className="text-[11px] text-slate-400">{client.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[12px] text-slate-500">
                      {client.cif}
                    </td>
                    <td className="px-5 py-3 text-[13px] text-slate-600">
                      {client.invoices.length}
                    </td>
                    <td className="px-5 py-3">
                      {pending > 0 ? (
                        <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-[11px] font-semibold text-yellow-700">
                          {pending} pendiente{pending !== 1 ? "s" : ""}
                        </span>
                      ) : (
                        <span className="text-[12px] text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/dashboard/worker/invoices?clientId=${client.id}`}
                        className="flex items-center justify-end gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
                      >
                        Ver facturas <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
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
