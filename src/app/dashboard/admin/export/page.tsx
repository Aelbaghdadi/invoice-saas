import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExportForm } from "./ExportForm";
import { Download, History } from "lucide-react";

const FORMAT_LABELS: Record<string, string> = {
  sage50: "Sage 50",
  contasol: "Contasol",
  a3con: "a3con (CSV)",
  a3excel: "A3 Excel",
};

export default async function ExportPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  const [clients, exportHistory] = await Promise.all([
    prisma.client.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, cif: true },
    }),
    prisma.exportBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  if (clients.length === 0) {
    return (
      <div>
        <h1 className="mb-1 text-[20px] font-bold text-slate-900">Exportar facturas</h1>
        <p className="mb-6 text-[13px] text-slate-400">
          Genera archivos CSV compatibles con tu software contable
        </p>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-400">
          <Download className="mb-3 h-10 w-10 opacity-30" />
          <p className="text-[14px] font-medium">No hay clientes registrados</p>
          <p className="text-[13px]">Crea un cliente primero para poder exportar facturas.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-bold text-slate-900">Exportar facturas</h1>
        <p className="mt-1 text-[13px] text-slate-400">
          Genera archivos CSV listos para importar en Sage 50, Contasol o a3con
        </p>
      </div>

      <ExportForm clients={clients} />

      {/* Export history */}
      {exportHistory.length > 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <History className="h-4 w-4 text-slate-400" />
            <h2 className="text-[14px] font-semibold text-slate-800">Historial de exportaciones</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3">Fecha</th>
                  <th className="px-5 py-3">Formato</th>
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Periodo</th>
                  <th className="px-5 py-3">Facturas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {exportHistory.map((batch) => (
                  <tr key={batch.id} className="text-slate-700">
                    <td className="px-5 py-3">{batch.createdAt.toLocaleDateString("es-ES")}</td>
                    <td className="px-5 py-3">{FORMAT_LABELS[batch.format] ?? batch.format}</td>
                    <td className="px-5 py-3">{batch.clientId ? (clientMap.get(batch.clientId) ?? "—") : "Todos"}</td>
                    <td className="px-5 py-3">
                      {batch.periodMonth && batch.periodYear
                        ? `${new Date(0, batch.periodMonth - 1).toLocaleString("es", { month: "long" })} ${batch.periodYear}`
                        : "—"}
                    </td>
                    <td className="px-5 py-3">{batch.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
