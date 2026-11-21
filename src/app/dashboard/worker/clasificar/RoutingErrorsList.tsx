"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { formatDateTimeEs } from "@/lib/dates";

export type RoutingErrorRow = {
  id: string;
  filename: string;
  /** «[ERR-OCR-005] mensaje»: el código va en un chip y el texto aparte. */
  lastOcrError: string | null;
  uploadedAt: string;
};

/**
 * Las de una subida entre varios que no se pudieron leer. Sin empresa
 * asignada no salen en ningún otro listado: «Reprocesar» es su única salida.
 */
export function RoutingErrorsList({ rows }: { rows: RoutingErrorRow[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reprocess(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/invoices/${id}/process`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError(data.error ?? "No se pudo reprocesar la factura.");
        return;
      }
      success("Enviada a leer otra vez");
      router.refresh();
    } catch {
      toastError("Error de conexión al reprocesar.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((row) => {
        const match = (row.lastOcrError ?? "").match(/^\[(ERR-[A-Z]+-\d+)\]\s*(.*)/);
        const code = match?.[1];
        const message = match?.[2] ?? row.lastOcrError;
        return (
          <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-slate-700" title={row.filename}>{row.filename}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                  {code && <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-red-600">{code}</span>}
                  <span className="truncate">{message || "No se pudo leer la factura."}</span>
                  <span className="text-slate-400">· subida el {formatDateTimeEs(row.uploadedAt)}</span>
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => reprocess(row.id)}
              disabled={busyId !== null}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50"
            >
              {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Reprocesar
            </button>
          </li>
        );
      })}
    </ul>
  );
}
