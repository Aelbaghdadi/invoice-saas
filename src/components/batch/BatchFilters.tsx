"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { X } from "lucide-react";

type Props = {
  /** Clientes seleccionables (asignados al gestor / de la firma del admin). */
  clients: { id: string; name: string }[];
  /** Ruta base de la pantalla (/dashboard/worker/batch o /dashboard/admin/batch). */
  basePath: string;
};

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const ESTADOS = [
  { value: "pendientes", label: "Pendientes" },
  { value: "por_cerrar", label: "Por cerrar" },
  { value: "cerrados", label: "Cerrados" },
  { value: "todos", label: "Todos" },
];

export function BatchFilters({ clients, basePath }: Props) {
  const router = useRouter();
  const sp = useSearchParams();

  // Los controles se leen directamente de la URL (no hay estado local):
  // cualquier cambio navega y la pantalla se vuelve a pintar filtrada.
  const clientId = sp.get("clientId") ?? "";
  const year = sp.get("year") ?? "";
  const month = sp.get("month") ?? "";
  const type = sp.get("type") ?? "";
  // Estado por defecto: solo lo pendiente (oculta completados y cerrados).
  const estado = sp.get("estado") ?? "pendientes";

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => nowYear - i);

  // Aplica al instante: parte de los valores actuales de la URL y sobreescribe
  // el que cambia. replace (no push) para no llenar el historial de pasos.
  const apply = useCallback(
    (overrides: Record<string, string>) => {
      const v = { clientId, year, month, type, estado, ...overrides };
      const params = new URLSearchParams();
      if (v.clientId) params.set("clientId", v.clientId);
      if (v.year) params.set("year", v.year);
      if (v.month) params.set("month", v.month);
      if (v.type) params.set("type", v.type);
      if (v.estado && v.estado !== "pendientes") params.set("estado", v.estado);
      const qs = params.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    },
    [clientId, year, month, type, estado, basePath, router],
  );

  const hasFilters = clientId || year || month || type || estado !== "pendientes";
  const inputCls =
    "w-full rounded-lg border border-slate-200 py-2 px-3 text-[12px] text-slate-700 outline-none focus:border-accent-500 focus:ring-1 focus:ring-accent-100";

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {/* Estado — segmentado, el filtro principal. */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {ESTADOS.map((e) => (
          <button
            key={e.value}
            type="button"
            onClick={() => apply({ estado: e.value })}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
              estado === e.value
                ? "bg-blue-600 text-white"
                : "border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {e.label}
          </button>
        ))}
        {hasFilters && (
          <button
            type="button"
            onClick={() => router.replace(basePath)}
            className="ml-auto flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-500 transition hover:bg-slate-50"
          >
            <X className="h-3 w-3" /> Limpiar
          </button>
        )}
      </div>

      {/* Cliente / Año / Mes / Tipo — aplican al cambiar. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Cliente</label>
          <select value={clientId} onChange={(e) => apply({ clientId: e.target.value })} className={inputCls}>
            <option value="">Todos</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Año</label>
          <select value={year} onChange={(e) => apply({ year: e.target.value })} className={inputCls}>
            <option value="">Todos</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Mes</label>
          <select value={month} onChange={(e) => apply({ month: e.target.value })} className={inputCls}>
            <option value="">Todos</option>
            {MESES.map((m, i) => (
              <option key={m} value={String(i + 1)}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400">Tipo</label>
          <select value={type} onChange={(e) => apply({ type: e.target.value })} className={inputCls}>
            <option value="">Todos</option>
            <option value="PURCHASE">Recibidas</option>
            <option value="SALE">Emitidas</option>
          </select>
        </div>
      </div>
    </div>
  );
}
