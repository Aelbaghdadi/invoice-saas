import { Download, History } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { formatDateTimeEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { PAGE_SIZE, pageWindow, parsePage } from "@/lib/listing";
import { exportStorageKey } from "@/lib/exportBatch";
import type { ExportFormat } from "@/lib/exportFormats";
import { isStorageConfigured, objectExists } from "@/lib/storage";
import { clientSheetHref } from "@/lib/clientSheet";

const INVOICE_TYPE_LABELS: Record<string, string> = { ALL: "Todas", PURCHASE: "Recibidas", SALE: "Emitidas" };
const FORMAT_LABELS: Record<string, string> = { a3excel: "A3 (Excel)", a3con: "A3 (CSV)", sage50: "Sage 50", contasol: "Contasol" };
/** Igual que en Exportar: con Garage colgado la pagina se pinta igual. */
const FILE_CHECK_TIMEOUT_MS = 2_000;

/** Los lotes exportados de este cliente, con «Volver a descargar» si la copia sigue guardada. */
export async function ClientExportsTab({
  clientId,
  firmId,
  basePath,
  page,
}: {
  clientId: string;
  firmId: string;
  basePath: string;
  page: string | undefined;
}) {
  // Un lote de este cliente y de esta asesoria (ExportBatch no tiene asesoria:
  // sale de sus facturas).
  const where = { clientId, items: { some: { invoice: { client: { advisoryFirmId: firmId } } } } };
  const total = await prisma.exportBatch.count({ where });
  const window = pageWindow(parsePage(page), total, PAGE_SIZE);
  const batches = total > 0
    ? await prisma.exportBatch.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: window.skip, take: window.take })
    : [];

  const userIds = [...new Set(batches.map((b) => b.userId))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds }, advisoryFirmId: firmId }, select: { id: true, name: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const storedFiles = new Set<string>();
  if (isStorageConfigured()) {
    const stored = await Promise.all(
      batches.map(async (b) =>
        (await objectExists(exportStorageKey(firmId, clientId, b.id, b.format as ExportFormat), { timeoutMs: FILE_CHECK_TIMEOUT_MS })) ? b.id : null,
      ),
    );
    for (const id of stored) if (id) storedFiles.add(id);
  }

  if (batches.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState icon={History} title="Sin exportaciones" description="Cuando exportes facturas de este cliente a A3, cada lote quedará aquí con su fichero." />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="px-5 py-3">Exportado el</th>
              <th className="px-5 py-3">Periodo</th>
              <th className="px-5 py-3">Tipo</th>
              <th className="px-5 py-3">Formato</th>
              <th className="px-5 py-3 text-right">Facturas</th>
              <th className="px-5 py-3">Usuario</th>
              <th className="px-5 py-3">Fichero</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {batches.map((b) => (
              <tr key={b.id} className="text-slate-700">
                <td className="whitespace-nowrap px-5 py-3 tabular-nums">{formatDateTimeEs(b.createdAt)}</td>
                <td className="whitespace-nowrap px-5 py-3">
                  {b.periodMonth && b.periodYear ? periodLabel(b.periodType, b.periodMonth, b.periodYear) : b.periodYear ? String(b.periodYear) : "—"}
                </td>
                <td className="px-5 py-3">{b.invoiceType ? (INVOICE_TYPE_LABELS[b.invoiceType] ?? b.invoiceType) : "—"}</td>
                <td className="px-5 py-3">{FORMAT_LABELS[b.format] ?? b.format}</td>
                <td className="px-5 py-3 text-right tabular-nums">{b.invoiceCount}</td>
                <td className="px-5 py-3">{userMap.get(b.userId) ?? "—"}</td>
                <td className="whitespace-nowrap px-5 py-3">
                  {storedFiles.has(b.id) ? (
                    <a href={`/api/export/batches/${b.id}/file`} download className="inline-flex items-center gap-1.5 font-medium text-blue-600 hover:text-blue-700">
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
      <Pagination window={window} noun="exportaciones" hrefFor={(p) => clientSheetHref(basePath, { tab: "exportaciones", page: p > 1 ? p : undefined })} />
    </div>
  );
}
