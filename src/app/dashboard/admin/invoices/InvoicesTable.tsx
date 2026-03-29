"use client";

import { useState, useMemo, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { FileText, Search, ArrowUpDown, ArrowUp, ArrowDown, CheckSquare, XSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkValidateInvoices, bulkExportInvoices } from "./actions";

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
};

type SortKey = "client" | "filename" | "period" | "type" | "status" | "date" | "total";
type SortDir = "asc" | "desc";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En analisis", variant: "yellow" },
  VALIDATED: { label: "Validada",    variant: "green" },
  EXPORTED:  { label: "Exportada",   variant: "slate" },
};

const ACTION_LABEL: Record<string, string> = {
  UPLOADED:  "Revisar",
  ANALYZING: "Ver",
  VALIDATED: "Exportar",
  EXPORTED:  "Archivar",
};

const STATUS_ORDER: Record<string, number> = {
  UPLOADED: 0, ANALYZING: 1, VALIDATED: 2, EXPORTED: 3,
};

export function InvoicesTable({ invoices }: { invoices: Invoice[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
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

  function toggleAll() {
    if (selected.size === sorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((i) => i.id)));
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

  function handleBulkExport() {
    const ids = [...selected];
    startTransition(async () => {
      const res = await bulkExportInvoices(ids);
      if (res.error) { showToast(res.error, "err"); return; }
      showToast(`${res.count} factura(s) marcadas como exportadas`, "ok");
      setSelected(new Set());
      router.refresh();
    });
  }

  const columns: { key: SortKey; label: string }[] = [
    { key: "client", label: "Cliente" },
    { key: "filename", label: "Archivo" },
    { key: "period", label: "Periodo" },
    { key: "type", label: "Tipo" },
    { key: "status", label: "Estado" },
    { key: "total", label: "Total" },
    { key: "date", label: "Fecha" },
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
            onChange={(e) => setSearch(e.target.value)}
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
              onClick={handleBulkExport}
              disabled={isPending}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              Exportar
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
                    checked={sorted.length > 0 && selected.size === sorted.length}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                </th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 cursor-pointer hover:text-slate-600 select-none"
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
              {sorted.map((inv) => {
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
                    <td className="px-5 py-3.5">
                      <p className="text-[13px] font-semibold text-slate-800">{inv.client.name}</p>
                      <p className="text-[11px] text-slate-400">{inv.client.cif}</p>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 flex-shrink-0 text-slate-300" />
                        <span className="max-w-[140px] truncate text-[13px] text-slate-600">{inv.filename}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-slate-500">
                      {new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "short" })} {inv.periodYear}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                        {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] font-medium text-slate-700">
                      {inv.totalAmount !== null ? `${Number(inv.totalAmount).toLocaleString("es-ES", { minimumFractionDigits: 2 })} \u20AC` : "\u2014"}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-slate-400">
                      {inv.createdAt.slice(0, 10)}
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/dashboard/admin/invoices/${inv.id}`}
                        className="rounded-lg bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-600 hover:bg-blue-100 transition-colors"
                      >
                        {ACTION_LABEL[inv.status] ?? "Ver"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-12 text-center text-[13px] text-slate-400">
                    {search ? "Sin resultados para esta busqueda" : "Sin facturas"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
