"use client";

import { useActionState, useEffect } from "react";
import { Loader2, Lock } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  closePeriodFromBatch,
  type BatchAction,
} from "./actions";

type Props = {
  clientId: string;
  month: number;
  year: number;
  type: "PURCHASE" | "SALE";
  /** Si el periodo esta listo para cerrar (todo done) se muestra el boton. */
  readyToClose: boolean;
  /** Si ya estaba cerrado (o reabierto) — para ajustar el texto. */
  alreadyClosed: boolean;
};

/**
 * Acciones del lote:
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
  readyToClose,
  alreadyClosed,
}: Props) {
  const { success, error: toastError } = useToast();
  const [closeState, closeAction, closePending] = useActionState<BatchAction, FormData>(
    closePeriodFromBatch,
    null,
  );

  useEffect(() => {
    if (!closeState) return;
    if (closeState.error) toastError(closeState.error);
    else if (closeState.ok) success("Periodo cerrado");
  }, [closeState]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!readyToClose && !alreadyClosed) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
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
