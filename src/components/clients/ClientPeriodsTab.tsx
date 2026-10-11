import Link from "next/link";
import { CalendarCheck, Download, Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDateTimeEs } from "@/lib/dates";
import { exportPageHref } from "@/lib/exportPage";
import { clientSheetHref, type PeriodRow } from "@/lib/clientSheet";
import type { ClientSheetRole } from "./links";

/** Todos los periodos con facturas: cuantas hay, cuantas faltan, cuantas han
 *  salido a A3 y si el periodo esta cerrado. */
export function ClientPeriodsTab({
  clientId,
  periods,
  role,
  basePath,
}: {
  clientId: string;
  periods: PeriodRow[];
  role: ClientSheetRole;
  basePath: string;
}) {
  if (periods.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState icon={CalendarCheck} title="Sin periodos" description="Cuando haya facturas, aquí verás cada mes o trimestre con su estado." />
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="px-5 py-3 text-left">Periodo</th>
              <th className="px-5 py-3 text-right">Recibidas</th>
              <th className="px-5 py-3 text-right">Emitidas</th>
              <th className="px-5 py-3 text-right">Pendientes</th>
              <th className="px-5 py-3 text-right">Validadas</th>
              <th className="px-5 py-3 text-right">Rechazadas</th>
              <th className="px-5 py-3 text-right">Exportadas</th>
              <th className="px-5 py-3 text-left">Cierre</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {periods.map((p) => {
              const quarter = p.periodType === "QUARTERLY" ? Math.ceil(p.periodMonth / 3) : undefined;
              const invoicesHref = clientSheetHref(basePath, {
                tab: "facturas",
                year: p.periodYear,
                ...(quarter ? { quarter } : { month: p.periodMonth }),
              });
              const allDone = p.pending === 0 && p.total > 0;
              const allExported = p.exported >= p.total - p.rejected && p.total - p.rejected > 0;
              return (
                <tr key={`${p.periodType}-${p.periodYear}-${p.periodMonth}`} className="hover:bg-slate-50/60">
                  <td className="whitespace-nowrap px-5 py-3 font-semibold text-slate-800">
                    <Link href={invoicesHref} className="hover:text-blue-700">{p.label}</Link>
                    <span className="ml-2 text-[11px] font-normal text-slate-400">{p.total} factura{p.total !== 1 ? "s" : ""}</span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-600">{p.purchases || <span className="text-slate-300">—</span>}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-600">{p.sales || <span className="text-slate-300">—</span>}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {p.pending > 0 ? (
                      <Link href={clientSheetHref(basePath, { tab: "facturas", estado: "pendientes", year: p.periodYear, ...(quarter ? { quarter } : { month: p.periodMonth }) })} className="rounded-md bg-amber-50 px-2 py-0.5 text-[12px] font-semibold text-amber-700 hover:bg-amber-100">
                        {p.pending}
                      </Link>
                    ) : (
                      <span className={allDone ? "text-emerald-600" : "text-slate-300"}>{allDone ? "0" : "—"}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-600">{p.validated || <span className="text-slate-300">—</span>}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-600">{p.rejected || <span className="text-slate-300">—</span>}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {p.exported > 0 ? (
                      <span className={allExported ? "font-semibold text-emerald-700" : "text-slate-600"}>{p.exported} / {p.total - p.rejected}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3">
                    {p.closed ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-slate-700" title={p.closedAt ? `Cerrado el ${formatDateTimeEs(p.closedAt)}` : undefined}>
                        <Lock className="h-3.5 w-3.5 text-slate-400" />
                        Cerrado
                      </span>
                    ) : (
                      <span className="text-[12px] text-slate-400">Abierto</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right">
                    {role === "ADMIN" && (
                      <Link
                        href={exportPageHref({ clientId, periodType: p.periodType, month: p.periodMonth, year: p.periodYear, type: "ALL" })}
                        className="inline-flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Exportar
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {role === "ADMIN" && (
        <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
          Los cierres se hacen y se reabren en{" "}
          <Link href="/dashboard/admin/closures" className="font-medium text-blue-600 hover:text-blue-700">Cierres</Link>.
        </p>
      )}
    </div>
  );
}
