import Link from "next/link";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { MediumBadge } from "@/components/archive/MediumBadge";
import { formatDateEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { invoiceOrderLabel, pageRangeLabel } from "@/lib/paperLocation";
import type { TacoDetail, TacoDetailRow } from "@/lib/tacoData";

const OTHER_FIRM = "Factura de otra empresa";

/** La factura: nº y tercero con NIF; en un taco de varios, también el cliente; mientras se analiza, el fichero. */
function InvoiceCell({ row, showClient, note }: { row: TacoDetailRow; showClient: boolean; note?: string | null }) {
  if (row.masked) return <span className="italic text-slate-400">{OTHER_FIRM}</span>;
  const rejected = row.status === "REJECTED";
  return (
    <div className="min-w-0">
      <p className={`max-w-[280px] truncate font-semibold ${rejected ? "text-slate-500 line-through decoration-slate-300" : "text-slate-800"}`}>
        {row.invoiceNumber ?? <span className="font-normal italic text-slate-400">Sin nº</span>}
      </p>
      {row.analyzing && row.filename ? (
        <p className="max-w-[280px] truncate text-[11px] text-slate-400" title={row.filename}>{row.filename}</p>
      ) : (row.thirdPartyName || row.thirdPartyCif) ? (
        <p className="max-w-[280px] truncate text-[11px] text-slate-500">
          {row.thirdPartyName ?? "—"}
          {row.thirdPartyCif && <span className="font-mono text-slate-400"> · {row.thirdPartyCif}</span>}
        </p>
      ) : null}
      {showClient && row.clientName && <p className="max-w-[280px] truncate text-[11px] text-slate-500">{row.clientName}</p>}
      {rejected && (
        <p className="max-w-[280px] truncate text-[11px] text-red-600" title={row.rejectionReason ?? undefined}>
          Rechazada{row.rejectionReason ? `: ${row.rejectionReason}` : ""}
        </p>
      )}
      {note && <p className="text-[11px] text-slate-400">{note}</p>}
    </div>
  );
}

function FichaLink({ row }: { row: TacoDetailRow }) {
  if (row.masked) return null;
  return (
    <Link
      href={`/dashboard/archivo/facturas/${row.invoiceId}`}
      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] font-semibold text-slate-600 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
    >
      Ficha
    </Link>
  );
}

const th = "px-3 py-3 text-left";
const td = "px-3 py-3";

/**
 * Las facturas de un taco página a página, con sus huecos (B-R18); de una
 * tanda digital, por orden de subida; de un taco ubicado a mano, en el orden
 * del archivo. Al gestor, las de otros clientes le salen sin datos.
 */
export function TacoSlotsTable({ detail }: { detail: TacoDetail }) {
  const showClient = detail.client == null;

  if (detail.kind === "digital") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className={th}>Orden</th>
              <th className={th}>Factura</th>
              <th className={`${th} hidden md:table-cell`}>Fecha</th>
              <th className="px-3 py-3 text-right">Total</th>
              <th className={th}>Original</th>
              <th className={`${th} hidden sm:table-cell`}>Estado</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {detail.rows.map((row) => (
              <tr key={row.invoiceId} className="align-top hover:bg-slate-50/60">
                <td className={`${td} tabular-nums text-slate-500`}>{row.uploadPosition ?? "—"}</td>
                <td className={td}><InvoiceCell row={row} showClient={showClient} /></td>
                <td className={`${td} hidden whitespace-nowrap tabular-nums text-slate-600 md:table-cell`}>{row.masked ? "" : formatDateEs(row.invoiceDate)}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-slate-700`}>{row.masked ? "" : formatEur(row.totalAmount)}</td>
                <td className={td}>{!row.masked && <MediumBadge medium={row.medium} reason={row.mediumReasonLabel} />}</td>
                <td className={`${td} hidden sm:table-cell`}>{!row.masked && <InvoiceStatusBadge status={row.status} />}</td>
                <td className={`${td} text-right`}><FichaLink row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (detail.kind === "archive") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className={th}>Factura</th>
              <th className={`${th} hidden md:table-cell`}>Fecha</th>
              <th className="px-3 py-3 text-right">Total</th>
              <th className={`${th} hidden sm:table-cell`}>Estado</th>
              <th className={`${th} hidden lg:table-cell`}>Nº de registro</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {detail.rows.map((row) => (
              <tr key={row.invoiceId} className="align-top hover:bg-slate-50/60">
                <td className={td}><InvoiceCell row={row} showClient={showClient} /></td>
                <td className={`${td} hidden whitespace-nowrap tabular-nums text-slate-600 md:table-cell`}>{row.masked ? "" : formatDateEs(row.invoiceDate)}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-slate-700`}>{row.masked ? "" : formatEur(row.totalAmount)}</td>
                <td className={`${td} hidden sm:table-cell`}>{!row.masked && <InvoiceStatusBadge status={row.status} />}</td>
                <td className={`${td} hidden whitespace-nowrap font-mono text-[12px] text-slate-700 lg:table-cell`}>{row.registerNumber ?? ""}</td>
                <td className={`${td} text-right`}><FichaLink row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const whole = detail.wholePdf;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            {whole ? (
              <>
                <th className={th}>Nº</th>
                <th className={th}>Págs. del PDF</th>
              </>
            ) : (
              <th className={th}>Pág.</th>
            )}
            <th className={th}>Factura</th>
            <th className={`${th} hidden md:table-cell`}>Fecha</th>
            <th className="px-3 py-3 text-right">Total</th>
            <th className={`${th} hidden sm:table-cell`}>Estado</th>
            <th className={`${th} hidden lg:table-cell`}>Nº de registro</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {detail.slots.flatMap((slot) => {
            const pageCells = (first: boolean) => whole ? (
              <>
                <td className={`${td} whitespace-nowrap font-semibold tabular-nums text-slate-800`}>{first && slot.order != null ? invoiceOrderLabel(slot.order) : ""}</td>
                <td className={`${td} whitespace-nowrap tabular-nums text-slate-600`}>{first ? pageRangeLabel(slot.page, slot.endPage) : ""}</td>
              </>
            ) : (
              <td className={`${td} whitespace-nowrap font-semibold tabular-nums text-slate-800`}>{first ? slot.page : ""}</td>
            );
            if (slot.rows.length === 0) {
              return [
                <tr key={`hueco-${slot.page}`} className="bg-slate-50/40">
                  {pageCells(true)}
                  <td colSpan={6} className={`${td} italic text-slate-400`}>{slot.label}</td>
                </tr>,
              ];
            }
            // En la primera fila, el texto del hueco: «3 facturas en el mismo papel», «No es papel…»
            return slot.rows.map((row, i) => (
              <tr key={row.invoiceId} className={`align-top hover:bg-slate-50/60 ${slot.kind === "invoices" ? "" : "bg-slate-50/40"}`}>
                {pageCells(i === 0)}
                <td className={td}>
                  <InvoiceCell row={row} showClient={showClient} note={i === 0 ? slot.label : null} />
                </td>
                <td className={`${td} hidden whitespace-nowrap tabular-nums text-slate-600 md:table-cell`}>{row.masked ? "" : formatDateEs(row.invoiceDate)}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums text-slate-700`}>{row.masked ? "" : formatEur(row.totalAmount)}</td>
                <td className={`${td} hidden sm:table-cell`}>{!row.masked && <InvoiceStatusBadge status={row.status} />}</td>
                <td className={`${td} hidden whitespace-nowrap font-mono text-[12px] text-slate-700 lg:table-cell`}>{row.registerNumber ?? ""}</td>
                <td className={`${td} text-right`}><FichaLink row={row} /></td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
