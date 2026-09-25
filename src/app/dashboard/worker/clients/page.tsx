import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Building2, FileText } from "lucide-react";
import Link from "next/link";
import { PENDING_WORK } from "@/lib/invoiceStatuses";

export default async function WorkerClientsPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");

  // ADMIN ve todos los clientes de su firma; WORKER solo los asignados.
  // Empaquetamos como `{ client }` para no cambiar el render.
  // Solo recuentos: traer las facturas de cada cliente para contarlas eran
  // decenas de miles de filas en cada carga.
  const assignments = session.user.role === "ADMIN"
    ? await prisma.client
        .findMany({
          where: session.user.advisoryFirmId
            ? { advisoryFirmId: session.user.advisoryFirmId, isUnclassifiedBucket: false }
            : { id: { in: [] } },
          include: { _count: { select: { invoices: true } } },
          orderBy: { name: "asc" },
        })
        .then((cs) => cs.map((client) => ({ client })))
        .catch(() => [])
    : await prisma.workerClientAssignment
        .findMany({
          where: { workerId: session.user.id },
          include: {
            client: {
              include: { _count: { select: { invoices: true } } },
            },
          },
          orderBy: { client: { name: "asc" } },
        })
        .catch(() => []);

  const clientIds = assignments.map(({ client }) => client.id);
  const pendingRows = clientIds.length === 0
    ? []
    : await prisma.invoice
        .groupBy({
          by: ["clientId"],
          where: { clientId: { in: clientIds }, status: { in: PENDING_WORK } },
          _count: true,
        })
        .catch(() => []);
  const pendingByClient = new Map(pendingRows.map((row) => [row.clientId, row._count]));

  return (
    <div>
      <PageHeader
        title={session.user.role === "ADMIN" ? "Clientes" : "Mis Clientes"}
        description={
          session.user.role === "ADMIN"
            ? `${assignments.length} cliente${assignments.length !== 1 ? "s" : ""} en la asesoría`
            : `${assignments.length} cliente${assignments.length !== 1 ? "s" : ""} asignado${assignments.length !== 1 ? "s" : ""}`
        }
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
                {["Cliente", "CIF", "Facturas", "Pendientes", "Acciones"].map((h) => (
                  <th
                    key={h}
                    className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${h === "Facturas" ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {assignments.map(({ client }) => {
                const pending = pendingByClient.get(client.id) ?? 0;
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
                          <p className="text-[11px] text-slate-400">{client.email ?? <span className="italic text-slate-300">Sin acceso al portal</span>}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono text-[12px] text-slate-500">
                      {client.cif}
                    </td>
                    <td className="px-5 py-3 text-right text-[13px] tabular-nums text-slate-600">
                      {client._count.invoices.toLocaleString("es-ES")}
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
                    <td className="px-5 py-3">
                      <Link
                        href={`/dashboard/worker/clients/${client.id}`}
                        className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                      >
                        Ver
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
