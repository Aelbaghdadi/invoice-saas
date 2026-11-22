"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Select, type SelectOption } from "@/components/ui/Select";
import { tacosHref, type TacoListEstado, type TacoListQuery } from "@/lib/tacoListParams";

type Filters = Omit<TacoListQuery, "page">;

const ESTADOS: SelectOption[] = [
  { value: "todos", label: "Estado: todos" },
  { value: "sin-guardar", label: "Sin guardar" },
  { value: "guardados", label: "Guardados" },
  { value: "devueltos", label: "Devueltos" },
  { value: "por-dividir", label: "Por dividir" },
  { value: "anulados", label: "Anulados" },
  { value: "digitales", label: "Subidas digitales" },
];

const key = (v: Filters) => JSON.stringify([v.estado, v.clientId, v.year, v.caja.trim()]);

/**
 * Filtros de la pestaña Tacos (5.6): estado, cliente, año del lote y caja. Van
 * a la URL y los aplica el servidor, como los del archivo del cliente. Al
 * filtrar se vuelve a la primera página.
 */
export function TacoFilters({
  values,
  clients,
  years,
}: {
  values: Filters;
  clients: { id: string; name: string }[];
  years: number[];
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
    startTransition(() => router.push(tacosHref(v)));
  }

  function onCaja(text: string) {
    setF((prev) => ({ ...prev, caja: text }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (key({ ...fRef.current, caja: text }) !== sent.current) go({ caja: text });
    }, 400);
  }

  const clientOptions: SelectOption[] = [
    { value: "", label: "Cliente: todos" },
    { value: "varios", label: "Varios clientes" },
    ...clients.map((client) => ({ value: client.id, label: client.name })),
  ];
  const yearOptions: SelectOption[] = [
    { value: "", label: "Año: todos" },
    ...years.map((year) => ({ value: String(year), label: String(year) })),
  ];
  const filtered = f.estado !== "todos" || !!f.clientId || f.year != null || !!f.caja.trim();

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select
        id="tacos-estado"
        aria-label="Estado"
        size="sm"
        className="w-[180px]"
        value={f.estado}
        options={ESTADOS}
        onChange={(v) => go({ estado: v as TacoListEstado })}
        searchable={false}
      />
      <Select
        id="tacos-cliente"
        aria-label="Cliente"
        size="sm"
        className="w-[220px]"
        value={f.clientId ?? ""}
        options={clientOptions}
        onChange={(v) => go({ clientId: v || null })}
      />
      <Select
        id="tacos-year"
        aria-label="Año del lote"
        size="sm"
        className="w-[130px]"
        value={f.year != null ? String(f.year) : ""}
        options={yearOptions}
        onChange={(v) => go({ year: v ? Number(v) : null })}
        searchable={false}
      />
      <form
        role="search"
        className="relative min-w-[200px] flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          go({ caja: fRef.current.caja });
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          enterKeyHint="search"
          aria-label="Caja"
          value={f.caja}
          onChange={(e) => onCaja(e.target.value)}
          placeholder="Caja (contiene)…"
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-9 text-[13px] placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
        />
        {isPending && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />}
      </form>
      {filtered && (
        <button
          type="button"
          onClick={() => go({ estado: "todos", clientId: null, year: null, caja: "" })}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3.5 w-3.5" />
          Quitar filtros
        </button>
      )}
    </div>
  );
}
