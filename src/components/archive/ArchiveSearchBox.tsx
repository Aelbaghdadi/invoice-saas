"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

/**
 * La caja del buscador «¿Dónde está?». La búsqueda la hace el servidor con la
 * consulta de la URL; aquí solo se escribe y se envía.
 */
export function ArchiveSearchBox({
  basePath,
  initialQuery,
  keep = {},
}: {
  basePath: string;
  initialQuery: string;
  /** Parámetros que se conservan al buscar (el ejercicio del resumen). */
  keep?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [pending, startTransition] = useTransition();

  const go = (text: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v) sp.set(k, v);
    if (text.trim()) sp.set("q", text.trim());
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${basePath}?${qs}` : basePath));
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go(q);
      }}
      className="flex flex-col gap-2 sm:flex-row"
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          aria-label="¿Dónde está?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nº de factura, proveedor, NIF, importe o R-2026/153"
          className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-9 text-[14px] placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
        />
        {q && !pending && (
          <button
            type="button"
            aria-label="Borrar la búsqueda"
            onClick={() => {
              setQ("");
              go("");
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {pending && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />}
      </div>
      <button
        type="submit"
        className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700"
      >
        <Search className="h-4 w-4" />
        Buscar
      </button>
    </form>
  );
}
