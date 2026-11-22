"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Select, type SelectOption } from "@/components/ui/Select";
import { archiveTabHref, type ArchiveTabQuery } from "@/lib/clientSheet";
import type { ArchiveMediumFilter, ArchiveTypeFilter } from "@/lib/archiveData";

const TYPES: { value: ArchiveTypeFilter; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "recibidas", label: "Recibidas" },
  { value: "emitidas", label: "Emitidas" },
];

const MEDIUMS: SelectOption[] = [
  { value: "todos", label: "Original: todos" },
  { value: "electronico", label: "Electrónico" },
  { value: "papel", label: "Papel" },
  { value: "por-confirmar", label: "Por confirmar" },
];

type Filters = Pick<ArchiveTabQuery, "type" | "medium" | "includeRejected" | "withoutLocation" | "q">;

const key = (f: Filters) => [f.type, f.medium, f.includeRejected ? "1" : "", f.withoutLocation ? "1" : "", f.q.trim()].join("\u0000");

/**
 * Filtros de la pestaña Archivo: recibidas o emitidas, el original, «Incluir
 * rechazadas», «Solo sin ubicación» y texto. Van a la URL (con el ejercicio) y los aplica el
 * servidor, que es quien ordena y pagina. Como InvoiceFilters, se llevan en
 * estado local y de la URL solo se copia lo que cambia por fuera.
 */
export function ArchiveFilters({
  basePath,
  fiscalYear,
  values,
}: {
  basePath: string;
  fiscalYear: number;
  values: Filters;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [f, setF] = useState<Filters>(values);
  const fRef = useRef(f);
  fRef.current = f;
  const sent = useRef(key(values));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const urlKey = key(values);
  useEffect(() => {
    if (urlKey === sent.current) return;
    sent.current = urlKey;
    setF(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function go(next: Partial<Filters>) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const v = { ...fRef.current, ...next };
    setF(v);
    sent.current = key(v);
    // Al filtrar se vuelve a la primera página.
    startTransition(() => router.push(archiveTabHref(basePath, { ...v, q: v.q.trim(), fiscalYear })));
  }

  function onText(text: string) {
    setF((prev) => ({ ...prev, q: text }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (key({ ...fRef.current, q: text }) !== sent.current) go({ q: text });
    }, 400);
  }

  const filtered = f.type !== "todas" || f.medium !== "todos" || f.includeRejected || f.withoutLocation || !!f.q.trim();

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label="Recibidas o emitidas">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={f.type === t.value}
            onClick={() => go({ type: t.value })}
            className={`rounded-md px-3 py-1 text-[13px] font-medium transition-all ${
              f.type === t.value ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Select
        id="archivo-original"
        aria-label="Original"
        size="sm"
        className="w-[180px]"
        value={f.medium}
        options={MEDIUMS}
        onChange={(v) => go({ medium: v as ArchiveMediumFilter })}
        searchable={false}
      />

      <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-600 shadow-sm">
        <input
          type="checkbox"
          checked={f.includeRejected}
          onChange={(e) => go({ includeRejected: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        Incluir rechazadas
      </label>

      <label
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-600 shadow-sm"
        title="El papel y lo «Por confirmar» que no está en ningún taco ni lo guarda el cliente"
      >
        <input
          type="checkbox"
          checked={f.withoutLocation}
          onChange={(e) => go({ withoutLocation: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        Solo sin ubicación
      </label>

      <form
        role="search"
        className="relative min-w-[220px] flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: fRef.current.q });
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          aria-label="Buscar en el archivo del cliente"
          value={f.q}
          onChange={(e) => onText(e.target.value)}
          placeholder="Nº de factura, tercero, NIF, importe, R-2026/153, T37 o caja 3…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-[13px] placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100 [&::-webkit-search-cancel-button]:hidden"
        />
        {/* La «×» nativa de Chrome va oculta: se montaba con la ruedita de carga. */}
        {f.q && !isPending && (
          <button
            type="button"
            aria-label="Borrar la búsqueda"
            onClick={() => go({ q: "" })}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {isPending && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />}
      </form>

      {filtered && (
        <button
          type="button"
          onClick={() => go({ type: "todas", medium: "todos", includeRejected: false, withoutLocation: false, q: "" })}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
          Quitar filtros
        </button>
      )}
    </div>
  );
}
