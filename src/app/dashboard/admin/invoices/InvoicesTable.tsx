"use client";

import { useState, useMemo, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { FileText, Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkValidateInvoices } from "./actions";

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
};

type SortKey = "client" | "filename" | "period" | "type" | "status" | "date" | "total";
type SortDir = "asc" | "desc";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En analisis", variant: "yellow" },
  ANALYZED:  { label: "Analizada",   variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",   variant: "red" },
  VALIDATED: { label: "Validada",    variant: "green" },
  REJECTED:  { label: "Rechazada",   variant: "red" },
  EXPORTED:        { label: "Exportada",      variant: "slate" },
  PENDING_REVIEW:  { label: "Pte. revisión",  variant: "blue" },
  NEEDS_ATTENTION: { label: "Con incidencias", variant: "yellow" },
};

const ACTION_LABEL: Record<string, string> = {
  UPLOADED:  "Revisar",
  ANALYZING: "Ver",
  ANALYZED:  "Revisar",
  OCR_ERROR: "Ver error",
  VALIDATED: "Exportar",
  REJECTED:  "Ver",
  EXPORTED:  "Archivar",
};

const STATUS_ORDER: Record<string, number> = {
  UPLOADED: 0, ANALYZING: 1, ANALYZED: 2, OCR_ERROR: 3, VALIDATED: 4, REJECTED: 5, EXPORTED: 6,
};

const PAGE_SIZE = 20;

export function InvoicesTable({ invoices }: { invoices: Invoice[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [page, setPage] = useState(0);
  const router = useRouter();

  // Filter
  const filtered = useMemo(() => {
    if (!search.trim()) return invoices;
    const q = search.toLowerCase();
    return invoices.filter(
      (inv) =>
        inv.client.name.toLowerCase().includes(q) ||
        inv.client.cif.toLowerCase().includes(q) ||
        inv.filename.toLowerCase().includes(q) ||
        (inv.totalAmount !== null && String(inv.totalAmount).includes(q))
    );
  }, [invoices, search]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "client":   cmp = a.client.name.localeCompare(b.client.name); break;
        case "filename": cmp = a.filename.localeCompare(b.filename); break;
        case "period":   cmp = (a.periodYear * 100 + a.periodMonth) - (b.periodYear * 100 + b.periodMonth); break;
        case "type":     cmp = a.type.localeCompare(b.type); break;
        case "status":   cmp = (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0); break;
        case "date":     cmp = a.createdAt.localeCompare(b.createdAt); break;
        case "total":    cmp = (a.totalAmount ?? 0) - (b.totalAmount ?? 0); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleAll() {
    if (selected.size === paginated.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(paginated.map((i) => i.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function showToast(msg: string, type: "ok" | "err") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  function handleBulkValidate() {
    const ids = [...selected];
    startTransition(async () => {
      const res = await bulkValidateInvoices(ids);
      if (res.error) { showToast(res.error, "err"); return; }
      showToast(`${res.count} factura(s) validadas`, "ok");
      setSelected(new Set());
      router.refresh();
    });
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
      showToast("Error de conexion al reprocesar", "err");
    }
  }

  const columns: { key: SortKey; label: string; hideMobile?: boolean }[] = [
    { key: "client", label: "Cliente" },
    { key: "filename", label: "Archivo" },
    { key: "period", label: "Periodo", hideMobile: true },
    { key: "type", label: "Tipo", hideMobile: true },
    { key: "status", label: "Estado" },
    { key: "total", label: "Total" },
    { key: "date", label: "Fecha", hideMobile: true },
  ];

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 text-slate-300" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-blue-500" />
      : <ArrowDown className="h-3 w-3 text-blue-500" />;
  }

  return (
    <div>
      {/* Search + bulk actions bar */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Buscar por cliente, CIF o factura..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-slate-600">
              {selected.size} seleccionada{selected.size !== 1 ? "s" : ""}
            </span>
            <button
              onClick={handleBulkValidate}
              disabled={isPending}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              Validar
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-slate-50 transition-colors"
            >
              Deseleccionar
            </button>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mb-4 rounded-lg px-4 py-2.5 text-[13px] font-medium ${
          toast.type === "ok"
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {toast.msg}
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/50">
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={paginated.length > 0 && paginated.every((i) => selected.has(i.id))}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                </th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={`px-3 md:px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 cursor-pointer hover:text-slate-600 select-none ${col.hideMobile ? "hidden md:table-cell" : ""}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      <SortIcon col={col.key} />
                    </span>
                  </th>
                ))}
                <th className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {paginated.map((inv) => {
                const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
                const isChecked = selected.has(inv.id);
                return (
                  <tr
                    key={inv.id}
                    className={`hover:bg-slate-50/60 transition-colors ${isChecked ? "bg-blue-50/40" : ""}`}
                  >
                    <td className="px-3 py-3.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(inv.id)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 md:px-5 py-3.5">
                      <p className="text-[13px] font-semibold text-slate-800">{inv.client.name}</p>
                      <p className="text-[11px] text-slate-400">{inv.client.cif}</p>
                    </td>
                    <td className="px-3 md:px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 flex-shrink-0 text-slate-300" />
                        <span className="max-w-[140px] truncate text-[13px] text-slate-600">{inv.filename}</span>
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
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-medium text-slate-700">
                      {inv.totalAmount !== null ? `${Number(inv.totalAmount).toLocaleString("es-ES", { minimumFractionDigits: 2 })} \u20AC` : "\u2014"}
                    </td>
                    <td className="hidden md:table-cell px-3 md:px-5 py-3.5 text-[13px] text-slate-400">
                      {inv.createdAt.slice(0, 10)}
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
                            href={`/dashboard/admin/invoices/${inv.id}`}
                            className="rounded-lg bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-600 hover:bg-blue-100 transition-colors"
                          >
                            {ACTION_LABEL[inv.status] ?? "Ver"}
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-[13px] text-slate-400">
                    {search ? "Sin resultados para esta busqueda" : "Sin facturas"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
            <p className="text-[12px] text-slate-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} de {sorted.length}
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {Array.from({ length: totalPages }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setPage(i)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-[12px] font-medium transition ${
                    page === i
                      ? "bg-blue-600 text-white"
                      : "text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page === totalPages - 1}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
