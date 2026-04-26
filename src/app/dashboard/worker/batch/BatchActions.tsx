"use client";

import { useActionState, useEffect } from "react";
import { Loader2, Zap, Lock } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  bulkValidateClean,
  closePeriodFromBatch,
  type BatchAction,
} from "./actions";

type Props = {
  clientId: string;
  month: number;
  year: number;
  type: "PURCHASE" | "SALE";
  /** Cuantas facturas hay en el bucket "clean" potencialmente auto-validables. */
  cleanCount: number;
  /** Si el periodo esta listo para cerrar (todo done) se muestra el boton. */
  readyToClose: boolean;
  /** Si ya estaba cerrado (o reabierto) — para ajustar el texto. */
  alreadyClosed: boolean;
};

/**
 * Acciones del lote:
 *  - "Auto-validar listas": intenta validar las clean con confianza alta
 *    + cuadre OK. Las que no pasan el filtro se quedan sin tocar.
 *  - "Cerrar periodo": crea/reactiva PeriodClosure si ya no queda
 *    trabajo pendiente en el periodo (todos los tipos).
 *
 * Se renderiza siempre, pero cada boton se oculta si no aplica.
 */
export function BatchActions({
  clientId,
  month,
  year,
  type,
  cleanCount,
  readyToClose,
  alreadyClosed,
}: Props) {
  const { success, error: toastError, info } = useToast();
  const [bulkState, bulkAction, bulkPending] = useActionState<BatchAction, FormData>(
    bulkValidateClean,
    null,
  );
  const [closeState, closeAction, closePending] = useActionState<BatchAction, FormData>(
    closePeriodFromBatch,
    null,
  );

  useEffect(() => {
    if (!bulkState) return;
    if (bulkState.error) {
      toastError(bulkState.error);
      return;
    }
    if (bulkState.ok) {
      const v = bulkState.validated ?? 0;
      const s = bulkState.skipped ?? 0;
      if (v > 0) {
        success(`${v} factura${v !== 1 ? "s" : ""} validada${v !== 1 ? "s" : ""} automaticamente`);
      } else {
        info("Ninguna factura cumplia los criterios de auto-validacion");
      }
      if (s > 0) {
        info(`${s} saltada${s !== 1 ? "s" : ""} para revision manual`);
      }
    }
  }, [bulkState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!closeState) return;
    if (closeState.error) toastError(closeState.error);
    else if (closeState.ok) success("Periodo cerrado");
  }, [closeState]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
      {cleanCount > 0 && (
        <form action={bulkAction}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="month" value={month} />
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="type" value={type} />
          <button
            type="submit"
            disabled={bulkPending}
            title="Valida las facturas PENDING_REVIEW con OCR >= 97% y cuadre OK"
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60"
          >
            {bulkPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            Auto-validar seguras ({cleanCount})
          </button>
        </form>
      )}

      {readyToClose && !alreadyClosed && (
        <form action={closeAction}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="month" value={month} />
          <input type="hidden" name="year" value={year} />
          <input type="hidden" name="type" value={type} />
          <button
            type="submit"
            disabled={closePending}
            title="Bloquea el periodo: no se podran subir ni modificar facturas"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
          >
            {closePending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Cerrar periodo
          </button>
        </form>
      )}

      {alreadyClosed && (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-500">
          <Lock className="h-3.5 w-3.5" />
          Periodo cerrado
        </span>
      )}
    </div>
  );
}
