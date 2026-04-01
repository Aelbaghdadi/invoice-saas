"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useCallback } from "react";
import { Search, X } from "lucide-react";

type Props = {
  users: { id: string; name: string }[];
  fields: string[];
};

const FIELD_LABELS: Record<string, string> = {
  status: "Estado",
  issuerName: "Emisor",
  issuerCif: "CIF emisor",
  receiverName: "Receptor",
  receiverCif: "CIF receptor",
  invoiceNumber: "Nº factura",
  invoiceDate: "Fecha",
  taxBase: "Base imponible",
  vatRate: "% IVA",
  vatAmount: "Cuota IVA",
  irpfRate: "% IRPF",
  irpfAmount: "Cuota IRPF",
  totalAmount: "Total",
  export: "Exportación",
  duplicate_warning: "Duplicado",
};

export function AuditFilters({ users, fields }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [userId, setUserId] = useState(searchParams.get("user") ?? "");
  const [field, setField] = useState(searchParams.get("field") ?? "");
  const [dateFrom, setDateFrom] = useState(searchParams.get("from") ?? "");
  const [dateTo, setDateTo] = useState(searchParams.get("to") ?? "");

  const apply = useCallback(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (userId) params.set("user", userId);
    if (field) params.set("field", field);
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    router.push(`/dashboard/admin/audit?${params.toString()}`);
  }, [search, userId, field, dateFrom, dateTo, router]);

  const clear = () => {
    setSearch("");
    setUserId("");
    setField("");
    setDateFrom("");
    setDateTo("");
    router.push("/dashboard/admin/audit");
  };

  const hasFilters = search || userId || field || dateFrom || dateTo;

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid grid-cols-5 gap-3">
        {/* Search */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Buscar</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-300" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder="Archivo, cliente..."
              className="w-full rounded-lg border border-slate-200 py-2 pl-8 pr-3 text-[12px] text-slate-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
            />
          </div>
        </div>

        {/* User filter */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Usuario</label>
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 px-3 text-[12px] text-slate-700 outline-none focus:border-blue-400"
          >
            <option value="">Todos</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </div>

        {/* Field filter */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Campo</label>
          <select
            value={field}
            onChange={(e) => setField(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 px-3 text-[12px] text-slate-700 outline-none focus:border-blue-400"
          >
            <option value="">Todos</option>
            {fields.map((f) => (
              <option key={f} value={f}>{FIELD_LABELS[f] ?? f}</option>
            ))}
          </select>
        </div>

        {/* Date from */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Desde</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 px-3 text-[12px] text-slate-700 outline-none focus:border-blue-400"
          />
        </div>

        {/* Date to */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Hasta</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full rounded-lg border border-slate-200 py-2 px-3 text-[12px] text-slate-700 outline-none focus:border-blue-400"
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={apply}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-blue-700"
        >
          Aplicar filtros
        </button>
        {hasFilters && (
          <button
            onClick={clear}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-500 transition hover:bg-slate-50"
          >
            <X className="h-3 w-3" />
            Limpiar
          </button>
        )}
      </div>
    </div>
  );
}
