"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Archive, Printer } from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { BoxLabelForm } from "@/components/archive/BoxLabelForm";
import { ConvertToTacoButton } from "@/components/archive/ConvertToTacoButton";
import { formatDayEs } from "@/lib/dates";
import { tacoShortLabel, type TacoState } from "@/lib/paperLocation";
import type { TacoListRow } from "@/lib/tacoData";

const STATE_VARIANTS: Record<TacoState, BadgeVariant> = {
  unfiled: "yellow",
  "pending-split": "yellow",
  box: "blue",
  returned: "slate",
  empty: "slate",
  voided: "slate",
};

const actionClass =
  "inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700";

/**
 * La tabla de la pestaña Tacos (5.6): los tacos del más reciente al más
 * antiguo, con su estado y «Ver», «Imprimir hoja» y, si está sin guardar
 * (row.canFile, como el filtro), «Guardar en caja…» en la propia fila. Con «Subidas digitales», las tandas
 * sin nº, con «Crear taco».
 */
export function TacoList({ rows, digital }: { rows: TacoListRow[]; digital: boolean }) {
  const [filing, setFiling] = useState<string | null>(null);
  const columns = 7;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <th className="px-3 py-3 text-left">{digital ? "Subida" : "Taco"}</th>
            <th className="px-3 py-3 text-left">Cliente</th>
            <th className="hidden px-3 py-3 text-left md:table-cell">Lote</th>
            <th className="hidden px-3 py-3 text-left sm:table-cell">Subido el</th>
            <th className="px-3 py-3 text-right">{digital ? "Ficheros" : "Páginas"}</th>
            <th className="px-3 py-3 text-left">{digital ? "" : "Estado"}</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((row) => (
            <Fragment key={row.id}>
              <tr className="align-top hover:bg-slate-50/60">
                <td className="whitespace-nowrap px-3 py-3">
                  <Link href={`/dashboard/archivo/tandas/${row.id}`} className="font-bold text-slate-900 hover:text-blue-700">
                    {row.tacoNumber != null ? tacoShortLabel(row.tacoNumber) : "Tanda digital"}
                  </Link>
                  {row.origin === "ARCHIVE" && <span className="block text-[11px] text-slate-400">ubicado a mano</span>}
                  {row.wholePdf && <span className="block text-[11px] text-slate-400">taco entero</span>}
                </td>
                <td className="max-w-[220px] px-3 py-3">
                  <span className={`block truncate ${row.clientName ? "font-medium text-slate-800" : "italic text-slate-500"}`}>
                    {row.clientName ?? "Varios clientes"}
                  </span>
                  <span className="block text-[11px] text-slate-400 md:hidden">{row.lotLabel}</span>
                </td>
                <td className="hidden px-3 py-3 text-slate-600 md:table-cell">{row.lotLabel}</td>
                <td className="hidden whitespace-nowrap px-3 py-3 sm:table-cell">
                  <span className="tabular-nums text-slate-700">{formatDayEs(row.createdAt)}</span>
                  {row.createdByName && <span className="block text-[11px] text-slate-400">por {row.createdByName}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-700">{row.pagesText}</td>
                <td className="px-3 py-3">
                  {row.state && row.stateLabel && (
                    <span title={row.state === "voided" && row.voidReason ? `Anulado: ${row.voidReason}` : undefined} className="inline-flex max-w-[220px]">
                      <Badge variant={STATE_VARIANTS[row.state]}>
                        <span className="truncate">{row.stateLabel}</span>
                      </Badge>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                    <Link href={`/dashboard/archivo/tandas/${row.id}`} className={actionClass}>Ver</Link>
                    {digital ? (
                      <ConvertToTacoButton batchId={row.id} label="Crear taco" />
                    ) : (
                      <>
                        {/* En el móvil solo se ve el icono: el nombre va en aria-label y title. */}
                        <a
                          href={`/imprimir/taco/${row.id}`}
                          target="_blank"
                          rel="noopener"
                          aria-label="Imprimir hoja"
                          title="Imprimir hoja"
                          className={actionClass}
                        >
                          <Printer className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Imprimir hoja</span>
                        </a>
                        {row.canFile && row.tacoNumber != null && (
                          <button
                            type="button"
                            aria-expanded={filing === row.id}
                            aria-label="Guardar en caja…"
                            title="Guardar en caja…"
                            onClick={() => setFiling((open) => (open === row.id ? null : row.id))}
                            className={actionClass}
                          >
                            <Archive className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Guardar en caja…</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
              {filing === row.id && row.tacoNumber != null && (
                <tr>
                  <td colSpan={columns} className="bg-slate-50/60 px-3 py-3">
                    <div className="max-w-lg">
                      <BoxLabelForm
                        batchId={row.id}
                        tacoNumber={row.tacoNumber}
                        current={{ boxLabel: row.boxLabel, returnedAt: row.returnedAt ? row.returnedAt.toISOString() : null }}
                        onDone={() => setFiling(null)}
                        onCancel={() => setFiling(null)}
                      />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
