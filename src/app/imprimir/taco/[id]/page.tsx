import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { canAccessUploadBatch, tacoViewer } from "@/lib/archiveAccess";
import { formatDateEs, formatDayEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { STATUS_LABELS } from "@/lib/invoiceStatuses";
import { invoiceOrderLabel, pageRangeLabel, tacoLabel, tacoShortLabel } from "@/lib/paperLocation";
import { loadTacoDetail, type TacoDetail, type TacoDetailRow } from "@/lib/tacoData";
import { wholeTacoInvoiceCount } from "@/lib/tacoDetailText";
import { PrintButton } from "./PrintButton";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "Hoja del taco" };

const n = (value: number) => value.toLocaleString("es-ES");
const BLANK = "____________________";
const OTHER_FIRM = "Factura de otra empresa";

// A4 vertical y en blanco y negro: la hoja va con el papel en la caja.
const PRINT_CSS = `
@page { size: A4; margin: 14mm; }
@media print {
  html, body { background: #fff !important; }
  .taco-sheet { color: #000 !important; }
  .taco-sheet * { color: #000 !important; border-color: #000 !important; }
  .taco-sheet tr { break-inside: avoid; }
}`;

function Cell({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`border-b border-slate-300 px-2 py-1.5 align-top ${className}`}>{children}</td>;
}

/** Tercero de una factura de la hoja: mientras se analiza, el nombre de su fichero (casa con la carpeta del escáner). */
function thirdParty(row: TacoDetailRow): React.ReactNode {
  if (row.masked) return <span className="italic">{OTHER_FIRM}</span>;
  if (row.analyzing) return <span className="text-slate-500">{row.filename}</span>;
  return row.thirdPartyName ?? "—";
}

function status(row: TacoDetailRow): string {
  if (row.masked) return "";
  if (row.status === "REJECTED") return row.rejectionReason ? `Rechazada: ${row.rejectionReason}` : "Rechazada";
  return STATUS_LABELS[row.status] ?? row.status;
}

function InvoiceCells({ row, showClient }: { row: TacoDetailRow; showClient: boolean }) {
  return (
    <>
      {showClient && <Cell>{row.masked ? "" : row.clientName}</Cell>}
      <Cell className="whitespace-nowrap tabular-nums">{row.masked ? "" : formatDateEs(row.invoiceDate)}</Cell>
      <Cell>{thirdParty(row)}</Cell>
      <Cell>{row.masked ? "" : row.invoiceNumber ?? "Sin nº"}</Cell>
      <Cell className="whitespace-nowrap text-right tabular-nums">{row.masked ? "" : formatEur(row.totalAmount)}</Cell>
      <Cell>{status(row)}</Cell>
    </>
  );
}

/** «Caja: …», «Devuelto al cliente el … · Recibí: ____» o la línea para escribir la caja. */
function boxLine(detail: TacoDetail): React.ReactNode {
  if (detail.boxLabel) return <>Caja: <strong>{detail.boxLabel}</strong></>;
  if (detail.returnedAt) return <>Devuelto al cliente el {formatDayEs(detail.returnedAt)} · Recibí: {BLANK}</>;
  return <>Caja: {BLANK}</>;
}

function pagesLine(detail: TacoDetail): string {
  if (detail.kind === "archive") return `Facturas: ${n(detail.rows.length)}`;
  if (detail.wholePdf) {
    const total = `Páginas del PDF: ${n(detail.pdfPageCount ?? 0)}`;
    return detail.split ? `${total} · ${n(wholeTacoInvoiceCount(detail))} facturas` : total;
  }
  return `Páginas: ${n(detail.slots.length)} (una por factura)`;
}

/**
 * Hoja del taco (5.14) para imprimir y guardar con el papel: el nº en grande,
 * de quién es, dónde va y, página a página, qué factura hay. Fuera del
 * dashboard (sin barra lateral); la propia página comprueba la sesión, el rol
 * y el acceso al taco (el proxy solo exige sesión fuera de /dashboard).
 */
export default async function TacoSheetPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") notFound();
  const viewer = await tacoViewer(session);
  if (!viewer) notFound();

  const { id } = await params;
  if (!(await canAccessUploadBatch(session, id))) notFound();
  const detail = await loadTacoDetail(viewer, id);
  if (!detail || detail.tacoNumber == null) notFound();

  const number = detail.tacoNumber;
  const showClient = detail.client == null;
  const whole = detail.kind === "taco" && detail.wholePdf;
  const unsplit = whole && !detail.split;
  const analyzingPages = detail.analyzingCount;

  return (
    <div className="taco-sheet mx-auto w-full max-w-[210mm] bg-white px-4 py-6 text-[12px] text-slate-900 sm:px-8 print:max-w-none print:p-0">
      <style>{PRINT_CSS}</style>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/dashboard/archivo/tandas/${detail.id}`} className="text-[13px] text-slate-500 hover:text-slate-800">
          ← Volver al {tacoLabel(number)}
        </Link>
        <PrintButton />
      </div>

      {analyzingPages > 0 && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 print:hidden">
          {analyzingPages === 1 ? "1 página se está analizando" : `${n(analyzingPages)} páginas se están analizando`}: si imprimes ahora
          saldrán con el nombre del fichero en vez del proveedor.
          <AutoRefresh signature={detail.statusSignature} />
        </p>
      )}

      <header className="flex items-start justify-between gap-4 border-b-2 border-slate-900 pb-3">
        <div>
          <p className="font-black leading-none tracking-tight" style={{ fontSize: "68pt" }}>TACO {number}</p>
          <p className="mt-1 text-[20pt] font-bold leading-none">{tacoShortLabel(number)}</p>
          {detail.voidedAt && (
            <p className="mt-2 text-[16pt] font-bold uppercase">ANULADO: {detail.voidReason}</p>
          )}
        </div>
        <p className="max-w-[45%] text-right text-[13px] font-semibold">{detail.firmName}</p>
      </header>

      <dl className="mt-3 space-y-1 text-[13px]">
        <div>
          {detail.client ? (
            <>Cliente: <strong>{detail.client.name}</strong> ({detail.client.cif})</>
          ) : (
            <>Clientes: varios</>
          )}
        </div>
        <div>Lote: {detail.lotLabel}</div>
        <div>
          Subido el {formatDayEs(detail.createdAt)}
          {detail.createdByName ? ` por ${detail.createdByName}` : ""}
        </div>
        <div>{pagesLine(detail)}</div>
        {!detail.voidedAt && <div>{boxLine(detail)}</div>}
        <div>
          Conservar hasta (como mínimo):{" "}
          {detail.retainOpen ? "sin fecha" : detail.retainUntil ? formatDateEs(detail.retainUntil) : "—"}
        </div>
      </dl>

      {detail.kind === "taco" && !detail.wholePdf && (
        <p className="mt-3 text-[12px] font-semibold">Cada «Pág.» es una factura, aunque tenga varias hojas: cuenta facturas, no hojas.</p>
      )}

      {unsplit ? (
        <p className="mt-6 text-[14px] font-semibold">Falta marcar dónde empieza cada factura.</p>
      ) : detail.kind === "archive" ? (
        <>
          <p className="mt-3 text-[12px] font-semibold">Papel ubicado a mano: no lleva un orden de páginas.</p>
          <table className="mt-2 w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b-2 border-slate-900 text-left">
                {showClient && <th className="px-2 py-1">Cliente</th>}
                <th className="px-2 py-1">Fecha</th>
                <th className="px-2 py-1">Tercero</th>
                <th className="px-2 py-1">Nº de factura</th>
                <th className="px-2 py-1 text-right">Total</th>
                <th className="px-2 py-1">Estado</th>
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => (
                <tr key={row.invoiceId}>
                  <InvoiceCells row={row} showClient={showClient} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <table className="mt-3 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b-2 border-slate-900 text-left">
              {whole ? (
                <>
                  <th className="px-2 py-1">Nº</th>
                  <th className="px-2 py-1">Págs. del PDF</th>
                </>
              ) : (
                <th className="px-2 py-1">Pág.</th>
              )}
              {showClient && <th className="px-2 py-1">Cliente</th>}
              <th className="px-2 py-1">Fecha</th>
              <th className="px-2 py-1">Tercero</th>
              <th className="px-2 py-1">Nº de factura</th>
              <th className="px-2 py-1 text-right">Total</th>
              <th className="px-2 py-1">Estado</th>
            </tr>
          </thead>
          <tbody>
            {detail.slots.flatMap((slot) => {
              const pageCells = (first: boolean) => whole ? (
                <>
                  <Cell className="whitespace-nowrap font-bold">{first && slot.order != null ? invoiceOrderLabel(slot.order) : ""}</Cell>
                  <Cell className="whitespace-nowrap tabular-nums">{first ? pageRangeLabel(slot.page, slot.endPage) : ""}</Cell>
                </>
              ) : (
                <Cell className="whitespace-nowrap font-bold tabular-nums">{first ? slot.page : ""}</Cell>
              );
              const span = (showClient ? 1 : 0) + 5;
              if (slot.rows.length === 0 || slot.kind !== "invoices") {
                // Un hueco, o papel que no está aquí: el motivo en una línea.
                return [
                  <tr key={`p-${slot.page}`}>
                    {pageCells(true)}
                    <Cell className="italic text-slate-600">
                      <span>{slot.label}</span>
                    </Cell>
                    <td colSpan={span - 1} className="border-b border-slate-300" />
                  </tr>,
                ];
              }
              return slot.rows.map((row, i) => (
                <tr key={row.invoiceId}>
                  {pageCells(i === 0)}
                  <InvoiceCells row={row} showClient={showClient} />
                </tr>
              ));
            })}
          </tbody>
        </table>
      )}

      {detail.kind === "taco" && !unsplit && (
        <footer className="mt-4 space-y-1 border-t border-slate-300 pt-2 text-[11px]">
          <p>El papel va en el orden de las páginas, tal como se escaneó: no hace falta ordenarlo.</p>
          {whole && (
            <p>
              Para encontrar una factura, cuenta facturas por su «Nº», no hojas: con un escáner a dos caras la página del PDF
              no es la hoja.
            </p>
          )}
        </footer>
      )}
    </div>
  );
}
