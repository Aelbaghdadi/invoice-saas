"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { Select } from "@/components/ui/Select";

type Props = {
  users: { id: string; name: string }[];
  /** Campos que aparecen en la auditoria, ya con su nombre legible. */
  fields: { value: string; label: string }[];
};

type Valores = { q: string; user: string; field: string; from: string; to: string };

const BASE_PATH = "/dashboard/admin/audit";

/** Lo que identifica unos filtros en la URL (el texto, recortado). */
const clave = (v: Valores) => [v.q.trim(), v.user, v.field, v.from, v.to].join("\u0000");

const labelClass = "mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-400";
// Mismo alto y letra que el <Select size="sm"> con el que comparten fila.
const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white py-2 text-[13px] text-slate-700 placeholder-slate-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100";

/**
 * Filtros de la auditoria. Se aplican al cambiar, como en Facturas y Lotes:
 * los desplegables al momento; el texto y las fechas al dejar de escribir
 * (tecleando una fecha a mano, cada cifra del año es un cambio y no tiene
 * que lanzar una busqueda por cifra).
 */
export function AuditFilters({ users, fields }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const valoresUrl: Valores = {
    q: searchParams.get("q") ?? "",
    user: searchParams.get("user") ?? "",
    field: searchParams.get("field") ?? "",
    from: searchParams.get("from") ?? "",
    to: searchParams.get("to") ?? "",
  };
  const [v, setV] = useState<Valores>(valoresUrl);

  // Refs para que la busqueda diferida use siempre lo ultimo, no lo que habia
  // cuando se programo.
  const vRef = useRef(v);
  vRef.current = v;
  const enviado = useRef(clave(valoresUrl));
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Si la URL cambia por lo que acabamos de pedir no se toca nada (se pisaria
  // lo que se sigue escribiendo); si viene de fuera (atras del navegador), se
  // adopta.
  const claveUrl = clave(valoresUrl);
  useEffect(() => {
    if (claveUrl === enviado.current) return;
    enviado.current = claveUrl;
    setV(valoresUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveUrl]);

  useEffect(() => () => {
    if (temporizador.current) clearTimeout(temporizador.current);
  }, []);

  function go(next: Partial<Valores>) {
    // Una navegacion explicita anula la diferida pendiente: si no, a los
    // 400 ms volvia a poner los filtros que se acababan de quitar.
    if (temporizador.current) {
      clearTimeout(temporizador.current);
      temporizador.current = null;
    }
    const n = { ...vRef.current, ...next };
    setV(n);
    enviado.current = clave(n);
    const sp = new URLSearchParams();
    if (n.q.trim()) sp.set("q", n.q.trim());
    if (n.user) sp.set("user", n.user);
    if (n.field) sp.set("field", n.field);
    if (n.from) sp.set("from", n.from);
    if (n.to) sp.set("to", n.to);
    // Sin "page": al filtrar se vuelve a la primera pagina.
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${BASE_PATH}?${qs}` : BASE_PATH));
  }

  function goDiferido(next: Partial<Valores>) {
    setV((prev) => ({ ...prev, ...next }));
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => {
      temporizador.current = null;
      if (clave({ ...vRef.current, ...next }) !== enviado.current) go(next);
    }, 400);
  }

  const hayFiltros = !!(v.q.trim() || v.user || v.field || v.from || v.to);

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="col-span-2 lg:col-span-1">
          <label htmlFor="auditoria-texto" className={labelClass}>Buscar</label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="auditoria-texto"
              type="search"
              value={v.q}
              onChange={(e) => goDiferido({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") go({ q: e.currentTarget.value });
              }}
              placeholder="Nº factura, archivo, cliente…"
              className={`${inputClass} pl-9 pr-9`}
            />
            {isPending && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
            )}
          </div>
        </div>

        <div>
          <label htmlFor="auditoria-usuario" className={labelClass}>Usuario</label>
          <Select
            id="auditoria-usuario"
            aria-label="Usuario"
            size="sm"
            value={v.user}
            onChange={(user) => go({ user })}
            options={[{ value: "", label: "Todos" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            searchable={users.length > 6}
          />
        </div>

        <div>
          <label htmlFor="auditoria-campo" className={labelClass}>Campo</label>
          <Select
            id="auditoria-campo"
            aria-label="Campo"
            size="sm"
            value={v.field}
            onChange={(field) => go({ field })}
            options={[{ value: "", label: "Todos" }, ...fields]}
          />
        </div>

        <div>
          <label htmlFor="auditoria-desde" className={labelClass}>Desde</label>
          <input
            id="auditoria-desde"
            type="date"
            value={v.from}
            max={v.to || undefined}
            onChange={(e) => goDiferido({ from: e.target.value })}
            className={`${inputClass} px-3`}
          />
        </div>

        <div>
          <label htmlFor="auditoria-hasta" className={labelClass}>Hasta</label>
          <input
            id="auditoria-hasta"
            type="date"
            value={v.to}
            min={v.from || undefined}
            onChange={(e) => goDiferido({ to: e.target.value })}
            className={`${inputClass} px-3`}
          />
        </div>
      </div>

      {hayFiltros && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => go({ q: "", user: "", field: "", from: "", to: "" })}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3.5 w-3.5" />
            Quitar filtros
          </button>
        </div>
      )}
    </div>
  );
}
