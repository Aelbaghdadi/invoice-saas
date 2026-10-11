import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { formatDateTimeEs } from "@/lib/dates";
import { pageWindow, parsePage } from "@/lib/listing";
import { auditActor, auditFieldLabel, formatAuditValue } from "@/lib/invoiceStatuses";
import { clientSheetHref } from "@/lib/clientSheet";
import { invoiceHref, type ClientSheetRole } from "./links";

/** Filas cortas en secuencia: mas por pagina que en facturas (como Auditoria). */
const ACTIVITY_PAGE_SIZE = 50;

/** Todo lo que se ha cambiado en las facturas de este cliente, de la auditoria. */
export async function ClientActivityTab({
  clientId,
  role,
  basePath,
  page,
}: {
  clientId: string;
  role: ClientSheetRole;
  basePath: string;
  page: string | undefined;
}) {
  const where = { invoice: { clientId } };
  const total = await prisma.auditLog.count({ where });
  const window = pageWindow(parsePage(page), total, ACTIVITY_PAGE_SIZE);
  const logs = total > 0
    ? await prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: window.skip,
        take: window.take,
        include: { user: { select: { name: true } }, invoice: { select: { id: true, invoiceNumber: true, filename: true } } },
      })
    : [];
  const thisHref = clientSheetHref(basePath, { tab: "actividad", page: window.page > 1 ? window.page : undefined });

  if (logs.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState icon={ClipboardList} title="Sin actividad" description="Aquí saldrá cada cambio en las facturas de este cliente: quién, qué y cuándo." />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="px-5 py-3">Fecha</th>
              <th className="px-5 py-3">Quién</th>
              <th className="px-5 py-3">Factura</th>
              <th className="px-5 py-3">Campo</th>
              <th className="px-5 py-3">Antes</th>
              <th className="px-5 py-3">Después</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {logs.map((log) => (
              <tr key={log.id} className="text-slate-700 hover:bg-slate-50/60">
                <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-slate-500">{formatDateTimeEs(log.createdAt)}</td>
                <td className="whitespace-nowrap px-5 py-2.5 font-medium text-slate-800">{auditActor(log.field, log.user.name, log.oldValue, log.newValue)}</td>
                <td className="px-5 py-2.5">
                  <Link href={invoiceHref(role, log.invoice.id, thisHref)} className="font-medium text-blue-600 hover:text-blue-700" title={log.invoice.filename}>
                    {log.invoice.invoiceNumber ?? log.invoice.filename}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-5 py-2.5 text-slate-600">{auditFieldLabel(log.field)}</td>
                <td className="max-w-[220px] truncate px-5 py-2.5 text-slate-500" title={formatAuditValue(log.oldValue, log.field)}>{formatAuditValue(log.oldValue, log.field)}</td>
                <td className="max-w-[220px] truncate px-5 py-2.5 font-medium text-slate-700" title={formatAuditValue(log.newValue, log.field)}>{formatAuditValue(log.newValue, log.field)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination window={window} noun="registros" hrefFor={(p) => clientSheetHref(basePath, { tab: "actividad", page: p > 1 ? p : undefined })} />
    </div>
  );
}
