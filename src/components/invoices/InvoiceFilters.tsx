"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2 } from "lucide-react";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export type InvoiceFilterValues = {
  clientId: string;
  /** "" (todos), "t1".."t4" (trimestre) o "m1".."m12" (mes). */
  period: string;
  year: string;
  /** "" (todas), "PURCHASE" o "SALE". */
  type: string;
  q: string;
};

/**
 * Barra de filtros de los listados de facturas: cliente, periodo, año, tipo y
 * texto. Todo va a la URL y lo resuelve el servidor, que es quien pagina: un
 * buscador en el navegador solo encontraba lo que ya estaba cargado, y para
 * eso habia que cargar todas las facturas de golpe.
 */
export function InvoiceFilters({
  basePath,
  clients,
  years,
  values,
  keep = {},
}: {
  basePath: string;
  clients: { id: string; name: string }[];
  years: number[];
  values: InvoiceFilterValues;
  /** Parametros que se conservan al filtrar (pestaña de estado, orden...). */
  keep?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [q, setQ] = useState(values.q);
  const primeraVez = useRef(true);

  // Si la URL cambia desde fuera (pestañas, atras del navegador), el texto
  // del buscador tiene que seguirla.
  useEffect(() => { setQ(values.q); }, [values.q]);

  function go(next: Partial<InvoiceFilterValues>) {
    const v = { ...values, q, ...next };
    const sp = new URLSearchParams();
    for (const [k, val] of Object.entries(keep)) if (val) sp.set(k, val);
    if (v.clientId) sp.set("clientId", v.clientId);
    if (v.period.startsWith("t")) sp.set("quarter", v.period.slice(1));
    else if (v.period.startsWith("m")) sp.set("month", v.period.slice(1));
    if (v.year) sp.set("year", v.year);
    if (v.type) sp.set("type", v.type);
    if (v.q.trim()) sp.set("q", v.q.trim());
    // Al filtrar se vuelve a la primera pagina: la 7 de antes puede no existir.
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${basePath}?${qs}` : basePath));
  }

  // Buscar mientras se escribe, sin lanzar una peticion por tecla.
  useEffect(() => {
    if (primeraVez.current) { primeraVez.current = false; return; }
    if (q === values.q) return;
    const t = setTimeout(() => go({ q }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hayFiltros = !!(values.clientId || values.period || values.year || values.type || values.q);
  const select =
    "rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 outline-none transition hover:border-slate-300 focus:border-accent-500 focus:ring-2 focus:ring-accent-100";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        id="filtro-cliente"
        aria-label="Cliente"
        className={`${select} min-w-[180px] max-w-[260px]`}
        value={values.clientId}
        onChange={(e) => go({ clientId: e.target.value })}
      >
        <option value="">Todos los clientes</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <select
        id="filtro-periodo"
        aria-label="Periodo"
        className={select}
        value={values.period}
        onChange={(e) => go({ period: e.target.value })}
      >
        <option value="">Todos los periodos</option>
        <optgroup label="Trimestre">
          <option value="t1">1er trimestre</option>
          <option value="t2">2º trimestre</option>
          <option value="t3">3er trimestre</option>
          <option value="t4">4º trimestre</option>
        </optgroup>
        <optgroup label="Mes">
          {MESES.map((m, i) => (
            <option key={m} value={`m${i + 1}`}>{m}</option>
          ))}
        </optgroup>
      </select>

      <select
        id="filtro-anio"
        aria-label="Año"
        className={select}
        value={values.year}
        onChange={(e) => go({ year: e.target.value })}
      >
        <option value="">Todos los años</option>
        {years.map((y) => (
          <option key={y} value={String(y)}>{y}</option>
        ))}
      </select>

      <select
        id="filtro-tipo"
        aria-label="Tipo de factura"
        className={select}
        value={values.type}
        onChange={(e) => go({ type: e.target.value })}
      >
        <option value="">Recibidas y emitidas</option>
        <option value="PURCHASE">Recibidas</option>
        <option value="SALE">Emitidas</option>
      </select>

      <form
        className="relative min-w-[220px] flex-1"
        onSubmit={(e) => { e.preventDefault(); go({ q }); }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          id="filtro-texto"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nº de factura, proveedor o CIF…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-[13px] placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
        />
        {isPending && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
        )}
      </form>

      {hayFiltros && (
        <button
          type="button"
          onClick={() => { setQ(""); go({ clientId: "", period: "", year: "", type: "", q: "" }); }}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
          Quitar filtros
        </button>
      )}
    </div>
  );
}
