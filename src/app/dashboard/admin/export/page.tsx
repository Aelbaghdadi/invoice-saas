import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExportForm } from "./ExportForm";
import { Download, History } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { formatDateTimeEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { PAGE_SIZE, pageWindow, parsePage } from "@/lib/listing";
import { exportStorageKey } from "@/lib/exportBatch";
import type { ExportFormat } from "@/lib/exportFormats";
import { isStorageConfigured, objectExists } from "@/lib/storage";

const HISTORY_FILE_CHECK_TIMEOUT_MS = 2000;

const INVOICE_TYPE_LABELS: Record<string, string> = {
  ALL: "Todas",
  PURCHASE: "Recibidas",
  SALE: "Emitidas",
};

type Props = {
  searchParams: Promise<{ page?: string }>;
};

export default async function ExportPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  const params = await searchParams;
  const requestedPage = parsePage(params.page);

  // ExportBatch no tiene firma: la asesoria sale de las facturas del lote.
  // Por clientId no vale, los lotes de "Todos" lo tienen a null. Sin firma no
  // hay historial (la exportacion ya rechaza a un admin sin asesoria).
  const firmId = session.user.advisoryFirmId;
  const historyWhere = firmId
    ? { items: { some: { invoice: { client: { advisoryFirmId: firmId } } } } }
    : null;

  const [clients, historyTotal] = await Promise.all([
    prisma.client.findMany({
      where: { isUnclassifiedBucket: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cif: true },
    }),
    historyWhere ? prisma.exportBatch.count({ where: historyWhere }) : Promise.resolve(0),
  ]);

  // Antes se cortaba en las 20 ultimas sin decirlo: en campaña de trimestre
  // eso no llega ni a un dia de exportaciones.
  const historyWindow = pageWindow(requestedPage, historyTotal, PAGE_SIZE);
  const exportHistory = historyWhere && historyTotal > 0
    ? await prisma.exportBatch.findMany({
        where: historyWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: historyWindow.skip,
        take: historyWindow.take,
      })
    : [];

  // ExportBatch no tiene relacion con User: se buscan solo los de esta pagina,
  // y solo de esta asesoria (si no, un lote ajeno enseñaria el nombre de un
  // usuario de otra firma; sale "—").
  const userIds = [...new Set(exportHistory.map((batch) => batch.userId))];
  const users = firmId && userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, advisoryFirmId: firmId },
        select: { id: true, name: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  // "Volver a descargar": solo los lotes con copia guardada. Los anteriores a
  // guardar el fichero no la tienen. Una comprobacion por fila de esta pagina,
  // cada una con 2 s como mucho: con Garage colgado la pagina se pinta igual
  // (las filas salen "No disponible") en vez de quedarse esperando.
  const storedFiles = new Set<string>();
  if (firmId && isStorageConfigured()) {
    const stored = await Promise.all(
      exportHistory.map(async (batch) =>
        batch.clientId
          && (await objectExists(
            exportStorageKey(firmId, batch.clientId, batch.id, batch.format as ExportFormat),
            { timeoutMs: HISTORY_FILE_CHECK_TIMEOUT_MS },
          ))
          ? batch.id
          : null,
      ),
    );
    for (const id of stored) if (id) storedFiles.add(id);
  }

  const header = (
    <PageHeader
      title="Exportar facturas"
      description="Genera el Excel listo para importar en A3 Asesor"
    />
  );

  if (clients.length === 0) {
    return (
      <div>
        {header}
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
      {header}

      <ExportForm clients={clients} />

      {/* Export history */}
      {historyTotal > 0 && (
        <div id="historial" className="mt-8 scroll-mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <History className="h-4 w-4 text-slate-400" />
            <h2 className="text-[14px] font-semibold text-slate-800">Historial de exportaciones</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-3">Exportado el</th>
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Periodo</th>
                  <th className="px-5 py-3">Tipo</th>
                  <th className="px-5 py-3 text-right">Facturas</th>
                  <th className="px-5 py-3">Usuario</th>
                  <th className="px-5 py-3">Fichero</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {exportHistory.map((batch) => (
                  <tr key={batch.id} className="text-slate-700">
                    <td className="whitespace-nowrap px-5 py-3 tabular-nums">{formatDateTimeEs(batch.createdAt)}</td>
                    <td className="px-5 py-3">{batch.clientId ? (clientMap.get(batch.clientId) ?? "—") : "Todos"}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      {batch.periodMonth && batch.periodYear
                        ? periodLabel(batch.periodType, batch.periodMonth, batch.periodYear)
                        : batch.periodYear
                          ? String(batch.periodYear)
                          : "—"}
                    </td>
                    <td className="px-5 py-3">
                      {batch.invoiceType ? (INVOICE_TYPE_LABELS[batch.invoiceType] ?? batch.invoiceType) : "—"}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{batch.invoiceCount}</td>
                    <td className="px-5 py-3">{userMap.get(batch.userId) ?? "—"}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      {storedFiles.has(batch.id) ? (
                        <a
                          href={`/api/export/batches/${batch.id}/file`}
                          download
                          className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:text-blue-700"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Volver a descargar
                        </a>
                      ) : (
                        <span className="text-slate-400">No disponible</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            window={historyWindow}
            noun="exportaciones"
            // Con el ancla se vuelve al historial y no arriba del formulario.
            hrefFor={(p) => (p > 1 ? `/dashboard/admin/export?page=${p}#historial` : "/dashboard/admin/export#historial")}
          />
        </div>
      )}
    </div>
  );
}
