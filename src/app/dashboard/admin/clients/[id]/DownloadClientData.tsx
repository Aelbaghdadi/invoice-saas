"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

/**
 * «Descargar los datos del cliente» (F-044). Antes de descargar pregunta si se
 * puede: si pasa del límite, el error sale aquí y no como un JSON descargado.
 */
export function DownloadClientData({ clientId }: { clientId: string }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/admin/clients/${clientId}/data-export`;

  async function download() {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(`${url}?check=1`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No se pueden descargar los datos del cliente.");
        return;
      }
      window.location.assign(url);
    } catch {
      setError("No se pueden descargar los datos del cliente. Inténtalo de nuevo.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={download}
        disabled={checking}
        className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3.5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
      >
        {checking ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : <Download className="h-4 w-4 text-slate-400" />}
        Descargar los datos del cliente
      </button>
      <p className="mt-1 text-[11px] text-slate-400">
        ZIP con las facturas, los originales, la auditoría y los lotes exportados. No borra nada.
      </p>
      {error && <p role="alert" className="mt-1 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
