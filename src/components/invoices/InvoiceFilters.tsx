"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Loader2 } from "lucide-react";
import { Select, type SelectOption } from "@/components/ui/Select";
import { MONTH_NAMES, QUARTER_OPTIONS } from "@/lib/period";

// Los mismos nombres que en Exportar y el resto de pantallas.
const PERIODOS: SelectOption[] = [
  { value: "", label: "Todos los periodos" },
  ...QUARTER_OPTIONS.map((q) => ({ value: `t${q.value}`, label: q.label, group: "Trimestre" })),
  ...MONTH_NAMES.map((m, i) => ({ value: `m${i + 1}`, label: m, group: "Mes" })),
];

const TIPOS: SelectOption[] = [
  { value: "", label: "Recibidas y emitidas" },
  { value: "PURCHASE", label: "Recibidas" },
  { value: "SALE", label: "Emitidas" },
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

/** Lo que identifica unos filtros en la URL (el texto, recortado). */
const clave = (v: InvoiceFilterValues) =>
  [v.clientId, v.period, v.year, v.type, v.q.trim()].join("\u0000");

/**
 * Barra de filtros de los listados de facturas: cliente, periodo, año, tipo y
 * texto. Todo va a la URL y lo resuelve el servidor, que es quien pagina.
 *
 * Los valores se llevan en estado local y no se leen de las props mientras
 * se navega: si no, el desplegable volvia al valor viejo hasta que llegaba la
 * pagina nueva, y un segundo cambio seguido pisaba al primero. De la URL solo
 * se copia cuando el cambio viene de fuera (atras del navegador, pestañas).
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
  const [f, setF] = useState<InvoiceFilterValues>(values);

  // Refs para que la busqueda diferida use siempre lo ultimo, no lo que habia
  // cuando se programo.
  const fRef = useRef(f);
  fRef.current = f;
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const enviado = useRef(clave(values));
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  // La URL ha cambiado. Si es lo que acabamos de pedir, no se toca nada (si
  // no, se pisaba lo que el usuario seguia escribiendo); si viene de fuera,
  // se adopta.
  const claveUrl = clave(values);
  useEffect(() => {
    if (claveUrl === enviado.current) return;
    enviado.current = claveUrl;
    setF(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveUrl]);

  useEffect(() => () => {
    if (temporizador.current) clearTimeout(temporizador.current);
  }, []);

  function go(next: Partial<InvoiceFilterValues>) {
    // Cualquier navegacion explicita anula la busqueda pendiente: si no, a
    // los 400 ms volvia a poner los filtros que se acababan de quitar.
    if (temporizador.current) {
      clearTimeout(temporizador.current);
      temporizador.current = null;
    }
    const v = { ...fRef.current, ...next };
    setF(v);
    enviado.current = clave(v);
    const sp = new URLSearchParams();
    for (const [k, val] of Object.entries(keepRef.current)) if (val) sp.set(k, val);
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

  function onTexto(texto: string) {
    setF((prev) => ({ ...prev, q: texto }));
    if (temporizador.current) clearTimeout(temporizador.current);
    // Buscar al dejar de escribir, sin una peticion por tecla.
    temporizador.current = setTimeout(() => {
      temporizador.current = null;
      if (clave({ ...fRef.current, q: texto }) !== enviado.current) go({ q: texto });
    }, 400);
  }

  const hayFiltros = !!(f.clientId || f.period || f.year || f.type || f.q.trim());

  const clientOptions: SelectOption[] = [
    { value: "", label: "Todos los clientes" },
    ...clients.map((c) => ({ value: c.id, label: c.name })),
  ];
  const yearOptions: SelectOption[] = [
    { value: "", label: "Todos los años" },
    ...years.map((y) => ({ value: String(y), label: String(y) })),
  ];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select
        id="filtro-cliente"
        aria-label="Cliente"
        size="sm"
        className="w-[230px]"
        value={f.clientId}
        options={clientOptions}
        onChange={(v) => go({ clientId: v })}
        searchable={clients.length > 6}
      />
      <Select
        id="filtro-periodo"
        aria-label="Periodo"
        size="sm"
        className="w-[180px]"
        value={f.period}
        options={PERIODOS}
        onChange={(v) => go({ period: v })}
        searchable={false}
      />
      <Select
        id="filtro-anio"
        aria-label="Año"
        size="sm"
        className="w-[150px]"
        value={f.year}
        options={yearOptions}
        onChange={(v) => go({ year: v })}
        searchable={false}
      />
      <Select
        id="filtro-tipo"
        aria-label="Tipo de factura"
        size="sm"
        className="w-[190px]"
        value={f.type}
        options={TIPOS}
        onChange={(v) => go({ type: v })}
        searchable={false}
      />

      <form
        className="relative min-w-[220px] flex-1"
        onSubmit={(e) => { e.preventDefault(); go({ q: fRef.current.q }); }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          id="filtro-texto"
          type="search"
          aria-label="Buscar facturas"
          value={f.q}
          onChange={(e) => onTexto(e.target.value)}
          placeholder="Nº de factura, proveedor, CIF o importe…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-[13px] placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
        />
        {isPending && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
        )}
      </form>

      {hayFiltros && (
        <button
          type="button"
          onClick={() => go({ clientId: "", period: "", year: "", type: "", q: "" })}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
          Quitar filtros
        </button>
      )}
    </div>
  );
}
