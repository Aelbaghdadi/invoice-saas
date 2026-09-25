"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { FileText, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import Link from "next/link";

type Invoice = {
  id: string;
  filename: string;
  status: string;
  type: string;
  periodMonth: number;
  periodYear: number;
  createdAt: string;
  totalAmount: number | null;
  client: { name: string; cif: string };
  hasDuplicateWarning: boolean;
  invoiceNumber: string | null;
  issuerName: string | null;
  issuerCif: string | null;
  receiverName: string | null;
  receiverCif: string | null;
  /** Ya salio en un Excel para A3. El estado sigue siendo VALIDATED. */
  exported: boolean;
  /** Salio en un Excel y despues se corrigio: A3 tiene el dato viejo. */
  pendingReexport: boolean;
};

type SortKey = "fecha" | "factura" | "cliente" | "periodo" | "total";

/** El tercero de la factura: el emisor en recibidas, el receptor en emitidas
 *  (la otra parte es el propio cliente). Es por donde la busca el gestor. */
function tercero(inv: Invoice): { name: string | null; cif: string | null } {
  return inv.type === "SALE"
    ? { name: inv.receiverName, cif: inv.receiverCif }
    : { name: inv.issuerName, cif: inv.issuerCif };
}

const STATUS_BADGE: Record<string, { label: string; variant: "blue" | "yellow" | "red" | "green" | "slate" | "purple" }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En análisis", variant: "yellow" },
  ANALYZED:  { label: "Analizada",   variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",   variant: "red" },
  VALIDATED: { label: "Validada",    variant: "green" },
  REJECTED:  { label: "Rechazada",   variant: "red" },
  EXPORTED:        { label: "Exportada",      variant: "slate" },
  PENDING_REVIEW:  { label: "Pte. revisión",  variant: "blue" },
  NEEDS_ATTENTION: { label: "Con incidencias", variant: "yellow" },
  SPLIT_SOURCE:    { label: "Dividida",        variant: "purple" },
};

const ACTION_LABEL: Record<string, string> = {
  UPLOADED:  "Revisar",
  ANALYZING: "Ver",
  ANALYZED:  "Revisar",
  OCR_ERROR: "Ver error",
  VALIDATED: "Ver / Corregir",
  REJECTED:  "Ver",
  EXPORTED:  "Ver / Corregir",
};

/**
 * Tabla de facturas del admin. Solo pinta la pagina que le llega: filtrar,
 * ordenar y paginar lo hace el servidor (ver page.tsx). Antes ordenaba y
 * paginaba aqui, sobre todas las facturas de la asesoria cargadas de golpe.
 *
 * No hay seleccion multiple ni "Validar" en bloque: validar una factura sin
 * abrirla es justo lo que no tiene que poder hacerse.
 */
export function InvoicesTable({
  invoices,
  sort,
  dir,
  sortHrefs,
}: {
  invoices: Invoice[];
  sort: SortKey;
  dir: "asc" | "desc";
  /** URL que ordena por cada columna (la calcula el servidor con los filtros). */
  sortHrefs: Record<SortKey, string>;
}) {
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);

  function showToast(msg: string, type: "ok" | "err") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleReprocess(invoiceId: string) {
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/process`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error ?? "Error al reprocesar la factura", "err");
        return;
      }
      showToast("Factura enviada a reprocesar", "ok");
      window.location.reload();
    } catch {
      showToast("Error de conexión al reprocesar", "err");
    }
  }

  const columns: { label: string; sortKey?: SortKey; hideMobile?: boolean }[] = [
    { label: "Cliente", sortKey: "cliente" },
    { label: "Factura", sortKey: "factura" },
    { label: "Periodo", sortKey: "periodo", hideMobile: true },
    { label: "Tipo", hideMobile: true },
    { label: "Estado" },
    { label: "Total", sortKey: "total" },
    // Es la fecha en la que se subio, no la de la factura: se llama asi.
    { label: "Subida", sortKey: "fecha", hideMobile: true },
  ];

  function SortIcon({ col }: { col: SortKey }) {
    if (sort !== col) return <ArrowUpDown className="h-3 w-3 text-slate-300" />;
    return dir === "asc"
      ? <ArrowUp className="h-3 w-3 text-blue-500" />
      : <ArrowDown className="h-3 w-3 text-blue-500" />;
  }

  return (
    <div>
      {toast && (
        <div className={`m-4 rounded-lg px-4 py-2.5 text-[13px] font-medium ${
          toast.type === "ok"
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {toast.msg}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80">
              {columns.map((col) => (
                <th
                  key={col.label}
                  className={`px-3 md:px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${col.hideMobile ? "hidden md:table-cell" : ""}`}
                >
                  {col.sortKey ? (
                    <Link href={sortHrefs[col.sortKey]} className="inline-flex items-center gap-1 hover:text-slate-700">
                      {col.label}
                      <SortIcon col={col.sortKey} />
                    </Link>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
              <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Acciones
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {invoices.map((inv) => {
              const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
              const t = tercero(inv);
              return (
                <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-3 md:px-5 py-3.5">
                    <p className="text-[13px] font-semibold text-slate-800">{inv.client.name}</p>
                    <p className="text-[11px] text-slate-400">{inv.client.cif}</p>
                  </td>
                  <td className="px-3 md:px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 flex-shrink-0 text-slate-300" />
                      <div className="min-w-0">
                        <p className="max-w-[200px] truncate text-[13px] font-medium text-slate-700" title={inv.filename}>
                          {inv.invoiceNumber ?? inv.filename}
                        </p>
                        {t.name && (
                          <p className="max-w-[200px] truncate text-[11px] text-slate-400" title={t.cif ?? undefined}>
                            {t.name}
                          </p>
                        )}
                      </div>
                      {inv.hasDuplicateWarning && (
                        <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 whitespace-nowrap">
                          Posible duplicado
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="hidden md:table-cell px-3 md:px-5 py-3.5 text-[13px] text-slate-500">
                    {new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "short" })} {inv.periodYear}
                  </td>
                  <td className="hidden md:table-cell px-3 md:px-5 py-3.5">
                    <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                      {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                    </Badge>
                  </td>
                  <td className="px-3 md:px-5 py-3.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={s.variant}>{s.label}</Badge>
                      {inv.exported && (
                        inv.pendingReexport ? (
                          <span
                            className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 whitespace-nowrap"
                            title="Salió en un Excel y se corrigió después: A3 tiene el dato viejo hasta que se vuelva a exportar"
                          >
                            Pdte. reexportar
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 whitespace-nowrap">
                            Exportada
                          </span>
                        )
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[13px] font-medium text-slate-700 tabular-nums whitespace-nowrap">
                    {inv.totalAmount !== null ? `${Number(inv.totalAmount).toLocaleString("es-ES", { minimumFractionDigits: 2 })} €` : "—"}
                  </td>
                  <td className="hidden md:table-cell px-3 md:px-5 py-3.5 text-[13px] text-slate-400 tabular-nums">
                    {new Date(inv.createdAt).toLocaleDateString("es-ES")}
                  </td>
                  <td className="px-3 md:px-5 py-3.5">
                    <div className="flex items-center gap-1.5">
                      {inv.status === "OCR_ERROR" ? (
                        <>
                          <button
                            onClick={() => handleReprocess(inv.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-orange-600 transition-colors"
                          >
                            <RefreshCw className="h-3 w-3" />
                            Reprocesar
                          </button>
                          <Link
                            href={`/dashboard/admin/invoices/${inv.id}`}
                            className="rounded-lg bg-red-50 px-2.5 py-1 text-[12px] font-semibold text-red-600 hover:bg-red-100 transition-colors"
                          >
                            Ver error
                          </Link>
                        </>
                      ) : (
                        <Link
                          /* Las validadas y exportadas van a la revision: es
                             la unica pantalla donde se pueden corregir, y es a
                             lo que se viene desde aqui. El resto, a la ficha
                             de solo lectura. */
                          href={inv.status === "VALIDATED" || inv.status === "EXPORTED"
                            ? `/dashboard/worker/review/${inv.id}`
                            : `/dashboard/admin/invoices/${inv.id}`}
                          className="whitespace-nowrap rounded-lg bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-600 hover:bg-blue-100 transition-colors"
                        >
                          {ACTION_LABEL[inv.status] ?? "Ver"}
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
