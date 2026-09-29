"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { InvoiceStatus } from "@prisma/client";
import { STUCK_ANALYZING_MS, isOcrStalled } from "@/lib/invoiceStatuses";

type Props = {
  /** Cuando arrancó el procesado (createdAt de la Invoice). */
  startedAt: Date;
  /** Estimacion histórica de cuanto tarda el OCR en esta firma.
   *  Si no la tenemos, usamos 10s como fallback razonable. */
  avgDurationMs?: number;
  /** Para saber si el analisis se ha parado (mismo corte que el cron). */
  invoiceId: string;
  status: InvoiceStatus;
  updatedAt: Date | string;
};

/**
 * Banner que se muestra mientras la factura está en UPLOADED/ANALYZING.
 * Tiene tres funciones:
 *  1) Comunicar al gestor que el OCR está corriendo (no es una pantalla rota).
 *  2) Dar una estimacion del tiempo (segun media historica de la firma).
 *  3) Auto-refrescar la pagina via `router.refresh()` cada 3s para que
 *     en cuanto el OCR termine, la pantalla cambie sola sin que el gestor
 *     tenga que recargar.
 */
export function OcrProcessingBanner({ startedAt, avgDurationMs = 10000, invoiceId, status, updatedAt }: Props) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - new Date(startedAt).getTime());
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startReprocess] = useTransition();
  const [reprocessError, setReprocessError] = useState<string | null>(null);

  useEffect(() => {
    const tickTimer = setInterval(() => {
      setElapsedMs(Date.now() - new Date(startedAt).getTime());
      setNow(Date.now());
    }, 500);
    const refreshTimer = setInterval(() => {
      router.refresh();
    }, 3000);
    return () => {
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    };
  }, [router, startedAt]);

  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const avgSec = Math.max(1, Math.floor(avgDurationMs / 1000));
  const remainingSec = Math.max(0, avgSec - elapsedSec);
  // Si llevamos > 2x el promedio, asumimos que va lento (algún reintento
  // o cola saturada). Cambiamos el mensaje en vez de seguir contando un
  // "restante" negativo.
  const overTime = elapsedMs > avgDurationMs * 2;
  const pct = overTime ? 95 : Math.min(95, Math.round((elapsedMs / avgDurationMs) * 100));

  // Pasado el corte se ofrece lanzarlo a mano. En ANALYZING es que se ha
  // parado (un redeploy o un OOM cortaron el OCR) y no va a terminar solo; en
  // UPLOADED puede estar esperando turno (reproceso masivo, hijas de una
  // division), asi que el texto es neutro.
  if (isOcrStalled(status, updatedAt, now)) {
    const stopped = status === "ANALYZING";
    const reprocess = () => {
      setReprocessError(null);
      startReprocess(async () => {
        try {
          const res = await fetch(`/api/invoices/${invoiceId}/process`, { method: "POST" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setReprocessError(data.error ?? "No se ha podido relanzar el análisis.");
          }
        } catch {
          setReprocessError("Error de conexión al relanzar el análisis.");
        }
        router.refresh();
      });
    };
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-amber-900">
              {stopped ? "El análisis se ha parado" : "El análisis aún no ha empezado"}
            </p>
            <p className="mt-0.5 text-[11px] text-amber-800/80">
              {stopped
                ? `Lleva más de ${STUCK_ANALYZING_MS / 60_000} minutos sin avanzar y no va a terminar solo. Relánzalo para poder revisar la factura.`
                : "Puede que esté esperando turno detrás de otras facturas. Si tienes prisa, lánzalo ahora."}
            </p>
            {reprocessError && <p className="mt-1 text-[11px] text-red-700">{reprocessError}</p>}
          </div>
          <button
            type="button"
            onClick={reprocess}
            disabled={isPending}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Reprocesar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-blue-600" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-blue-900">
            Analizando factura con OCR…
          </p>
          <p className="text-[11px] text-blue-700/80 mt-0.5">
            {overTime
              ? `${elapsedSec} s transcurridos — está tardando más de lo habitual, la cola puede estar saturada.`
              : `${elapsedSec} s transcurridos · ~${remainingSec} s restantes · suele tardar unos ${avgSec} s`
            }
          </p>
        </div>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-blue-100 overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
