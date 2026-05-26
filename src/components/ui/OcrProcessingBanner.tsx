"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

type Props = {
  /** Cuando arrancó el procesado (createdAt de la Invoice). */
  startedAt: Date;
  /** Estimacion histórica de cuanto tarda el OCR en esta firma.
   *  Si no la tenemos, usamos 10s como fallback razonable. */
  avgDurationMs?: number;
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
export function OcrProcessingBanner({ startedAt, avgDurationMs = 10000 }: Props) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - new Date(startedAt).getTime());

  useEffect(() => {
    const tickTimer = setInterval(() => {
      setElapsedMs(Date.now() - new Date(startedAt).getTime());
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
              ? `${elapsedSec}s transcurridos — está tardando más de lo habitual, la cola puede estar saturada.`
              : `${elapsedSec}s transcurridos · ~${remainingSec}s restantes (media de la firma: ${avgSec}s)`
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
