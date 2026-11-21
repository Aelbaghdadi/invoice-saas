"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Archive, ExternalLink, X } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { MediumBadge } from "@/components/archive/MediumBadge";
import { MediumSelect } from "@/components/archive/MediumSelect";
import { RetentionHoldForm } from "@/components/archive/RetentionHoldForm";
import { formatDateEs, formatDayEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { STATUS_LABELS } from "@/lib/invoiceStatuses";
import { RETENTION_HOLD_LABELS } from "@/lib/originalMedium";
import type { ArchivePeriodGroup, ArchiveTypeFilter, ClientArchiveRow } from "@/lib/archiveData";

/** Extensión del original en otro formato, para el botón: «.docx». */
function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{2,5})$/i.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/** La fecha de llegada al archivo: de una recibida, cuándo se recibió; de una
 *  emitida, cuándo se subió (no se «recibe»). */
const ARRIVAL_HEADERS: Record<ArchiveTypeFilter, string> = {
  recibidas: "Recibida el",
  emitidas: "Subida el",
  todas: "Recibida o subida el",
};

/**
 * La tabla de la pestaña Archivo: una página del archivo del ejercicio, en su
 * orden, con un subtítulo por periodo de deducción («Marzo 2026 · 38»). Se
 * pueden elegir filas para cambiar a la vez si son electrónicas o papel, o
 * «conservar más»: las de la página y, desde ahí, todas las de lo filtrado
 * (`selectable`, como mucho las que admite la acción).
 */
export function ClientArchiveTable({
  rows,
  periods,
  typeFilter = "todas",
  selectable,
}: {
  rows: ClientArchiveRow[];
  periods: ArchivePeriodGroup[];
  typeFilter?: ArchiveTypeFilter;
  /** Lo filtrado que se puede elegir de una vez, cuántas son en total y si hay filtro. */
  selectable?: { ids: string[]; total: number; filtered: boolean };
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [holdOpen, setHoldOpen] = useState(false);
  const countByPeriod = new Map(periods.map((p) => [p.key, p.count]));
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.invoiceId));
  // En el orden del archivo: las de lo filtrado (también las de otras páginas) y las de esta.
  const order = [...(selectable?.ids ?? []), ...rows.map((row) => row.invoiceId)];
  const selectedIds = [...new Set(order)].filter((id) => selected.has(id));
  const beyondPage = selectable && selectable.ids.length > rows.length ? selectable : null;
  const allFilterSelected = beyondPage != null && beyondPage.ids.every((id) => selected.has(id));
  const scopeLabel = beyondPage?.filtered ? "de este filtro" : "del ejercicio";

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => {
    setSelected(new Set());
    setHoldOpen(false);
  };

  return (
    <div>
      {selectedIds.length > 0 && (
        <div className="border-b border-blue-100 bg-blue-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-1 text-[13px] font-semibold text-blue-900">
              {selectedIds.length === 1 ? "1 seleccionada" : `${selectedIds.length} seleccionadas`}
            </p>
            {beyondPage && allSelected && !allFilterSelected && (
              <button
                type="button"
                onClick={() => setSelected(new Set(beyondPage.ids))}
                className="rounded-md px-2 py-1 text-[12px] font-semibold text-blue-700 underline-offset-2 hover:underline"
              >
                {beyondPage.ids.length < beyondPage.total
                  ? `Elegir las ${beyondPage.ids.length} primeras ${scopeLabel} (hay ${beyondPage.total.toLocaleString("es-ES")})`
                  : `Elegir las ${beyondPage.ids.length} ${scopeLabel}`}
              </button>
            )}
            <MediumSelect key={selectedIds.join(",")} invoiceIds={selectedIds} onDone={clear} />
            <button
              type="button"
              aria-expanded={holdOpen}
              onClick={() => setHoldOpen((open) => !open)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <Archive className="h-3.5 w-3.5 text-slate-400" />
              Conservar más…
            </button>
            <button
              type="button"
              onClick={clear}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-white hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
              Quitar selección
            </button>
          </div>
          {holdOpen && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <RetentionHoldForm
                key={selectedIds.join(",")}
                invoiceIds={selectedIds}
                initial={{ hold: true, reason: null, note: null }}
                bulk
                onDone={clear}
              />
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Elegir todas las de esta página"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.invoiceId)))}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </th>
              <th className="px-3 py-3 text-left">Nº de registro</th>
              <th className="hidden px-3 py-3 text-left md:table-cell">{ARRIVAL_HEADERS[typeFilter]}</th>
              <th className="px-3 py-3 text-left">Factura</th>
              <th className="hidden px-3 py-3 text-left md:table-cell">Fecha</th>
              <th className="px-3 py-3 text-right">Total</th>
              <th className="px-3 py-3 text-left">Original</th>
              <th className="hidden px-3 py-3 text-left lg:table-cell">Conservar hasta</th>
              <th className="hidden px-3 py-3 text-left sm:table-cell">Estado</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((row, i) => {
              const newPeriod = i === 0 || rows[i - 1].periodKey !== row.periodKey;
              const count = countByPeriod.get(row.periodKey);
              const rejected = row.status === "REJECTED";
              return (
                <Fragment key={row.invoiceId}>
                  {newPeriod && (
                    <tr className="bg-slate-50/80">
                      <td colSpan={10} className="px-3 py-2 text-[12px] font-semibold text-slate-600">
                        {row.periodLabel}
                        {count != null && <span className="font-normal text-slate-400"> · {count}</span>}
                      </td>
                    </tr>
                  )}
                  <tr className={`align-top hover:bg-slate-50/60 ${selected.has(row.invoiceId) ? "bg-blue-50/40" : ""}`}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Elegir ${row.invoiceNumber ?? "la factura"}`}
                        checked={selected.has(row.invoiceId)}
                        onChange={() => toggle(row.invoiceId)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {row.registerNumber ? (
                        <span className="font-mono text-[12px] font-semibold text-slate-800" title={row.registeredAt ? `Registrada el ${formatDayEs(row.registeredAt)}` : undefined}>
                          {row.registerNumber}
                        </span>
                      ) : (
                        <span className="text-[12px] text-slate-400" title="Se pone al exportar a A3">Sin registrar</span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-3 tabular-nums text-slate-500 md:table-cell">{formatDayEs(row.receivedAt)}</td>
                    <td className="px-3 py-3">
                      <p className={`max-w-[280px] truncate font-semibold ${rejected ? "text-slate-500 line-through decoration-slate-300" : "text-slate-800"}`}>
                        {row.invoiceNumber ?? <span className="font-normal italic text-slate-400">Sin nº</span>}
                      </p>
                      {(row.thirdPartyName || row.thirdPartyCif) && (
                        <p className="max-w-[280px] truncate text-[11px] text-slate-500">
                          {row.thirdPartyName ?? "—"}
                          {row.thirdPartyCif && <span className="font-mono text-slate-400"> · {row.thirdPartyCif}</span>}
                        </p>
                      )}
                      <p className="text-[11px] text-slate-400 sm:hidden">
                        {formatDateEs(row.invoiceDate)} · {STATUS_LABELS[row.status] ?? row.status}
                      </p>
                      {rejected && row.rejectionReason && (
                        <p className="max-w-[280px] truncate text-[11px] text-red-600" title={row.rejectionReason}>Rechazada: {row.rejectionReason}</p>
                      )}
                      {row.warnings.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {row.warnings.map((w) => (
                            <span
                              key={w.code}
                              className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                w.code === "split_part" ? "bg-slate-100 text-slate-600" : "border border-amber-200 bg-amber-50 text-amber-700"
                              }`}
                            >
                              {w.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-3 tabular-nums text-slate-600 md:table-cell">{formatDateEs(row.invoiceDate)}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-700">{formatEur(row.totalAmount)}</td>
                    <td className="px-3 py-3">
                      <MediumBadge medium={row.medium} reason={row.mediumReasonLabel} />
                      {row.originalDocument && (
                        <p className="mt-1 text-[10px] font-semibold uppercase text-slate-400" title={row.originalDocument.filename}>
                          + original {extensionOf(row.originalDocument.filename)}
                        </p>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-3 tabular-nums text-slate-600 lg:table-cell">
                      {row.retentionHold ? (
                        <span
                          className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700"
                          title={row.retentionHoldReason ? RETENTION_HOLD_LABELS[row.retentionHoldReason] : undefined}
                        >
                          Conservar más
                        </span>
                      ) : (
                        formatDateEs(row.retainUntil)
                      )}
                    </td>
                    <td className="hidden px-3 py-3 sm:table-cell">
                      <InvoiceStatusBadge status={row.status} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <a
                          href={`/api/archive/invoices/${row.invoiceId}/original`}
                          target="_blank"
                          rel="noopener"
                          title={row.originalDocument ? `Descargar ${row.originalDocument.filename}` : "Ver el original"}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Original</span>
                        </a>
                        <Link
                          href={`/dashboard/archivo/facturas/${row.invoiceId}`}
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                        >
                          Ficha
                        </Link>
                      </div>
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
