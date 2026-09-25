"use client";

import { useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

type Props = {
  name: string;
  cif: string;
  loteCount: number;
  invoiceCount: number;
  /** Suma de facturas con incidencias del cliente (chip de aviso). */
  attentionCount?: number;
  /** Si todos los lotes del cliente están completos/cerrados (chip verde). */
  allDone?: boolean;
  defaultOpen?: boolean;
  /** Si se pasa (el id del cliente), la sección recuerda en la sesión del
   *  navegador si estaba abierta. */
  storageKey?: string;
  children: React.ReactNode;
};

// Abierta/cerrada por cliente en sessionStorage: al volver a Lotes desde la
// revision o desde el menu salian todas cerradas y habia que buscar otra vez
// el cliente con el que se estaba. Se lee con useSyncExternalStore para no
// descuadrar la hidratacion (el server no ve el almacenamiento).
const STORAGE_PREFIX = "facturocr.lotes.abierto.";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readStored(storageKey: string | undefined): boolean | null {
  if (!storageKey) return null;
  try {
    const value = window.sessionStorage.getItem(STORAGE_PREFIX + storageKey);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

/**
 * Sección plegable de Lotes por cliente. La pantalla muestra los clientes con
 * lote activo (nombre + CIF + resumen) y, al pulsar, despliega sus lotes. Así
 * la vista queda limpia cuando hay muchos clientes. Las tarjetas de lote las
 * renderiza el server y se pasan como children (no se duplica markup).
 */
export function ClientAccordionSection({
  name, cif, loteCount, invoiceCount, attentionCount = 0, allDone = false, defaultOpen = false, storageKey, children,
}: Props) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const stored = useSyncExternalStore(subscribe, () => readStored(storageKey), () => null);
  const open = stored ?? localOpen;

  const toggle = () => {
    const next = !open;
    setLocalOpen(next);
    if (!storageKey) return;
    try {
      window.sessionStorage.setItem(STORAGE_PREFIX + storageKey, next ? "1" : "0");
    } catch {
      /* sin almacenamiento: se queda solo en memoria */
    }
    listeners.forEach((listener) => listener());
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50"
      >
        {open
          ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-slate-400" />
          : <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-400" />}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-slate-900">{name}</span>
          <span className="hidden font-mono text-[10px] text-slate-400 sm:inline">{cif}</span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {attentionCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              {attentionCount} con incidencias
            </span>
          )}
          {attentionCount === 0 && allDone && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              Completado
            </span>
          )}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
            {loteCount} lote{loteCount !== 1 ? "s" : ""} · {invoiceCount} factura{invoiceCount !== 1 ? "s" : ""}
          </span>
        </div>
      </button>
      {open && <div className="space-y-3 border-t border-slate-100 p-3">{children}</div>}
    </div>
  );
}
