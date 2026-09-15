"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Loader2, Lock, Ban, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  closePeriodFromBatch,
  rejectBatch,
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
  /** Numero de facturas del lote que se verian afectadas por "Rechazar lote". */
  rejectableCount: number;
};

/**
 * Acciones del lote:
 *  - "Cerrar periodo": crea/reactiva PeriodClosure si ya no queda
 *    trabajo pendiente en el periodo (todos los tipos).
 *  - "Rechazar lote": rechaza de golpe todas las facturas del lote que aun
 *    no esten exportadas/rechazadas (p.ej. se subio por error). Pide
 *    confirmación explícita y un motivo antes de ejecutar.
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
  rejectableCount,
}: Props) {
  const { success, error: toastError } = useToast();
  const [closeState, closeAction, closePending] = useActionState<BatchAction, FormData>(
    closePeriodFromBatch,
    null,
  );
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [isRejecting, startReject] = useTransition();

  useEffect(() => {
    if (!closeState) return;
    if (closeState.error) toastError(closeState.error);
    else if (closeState.ok) success("Periodo cerrado");
  }, [closeState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Llamada directa (no useActionState) para poder cerrar el panel de
  // confirmación desde el propio callback en vez de un efecto reaccionando
  // al resultado — evita el setState síncrono dentro de un effect.
  const handleRejectBatch = () => {
    setRejectError(null);
    startReject(async () => {
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("month", String(month));
      fd.set("year", String(year));
      fd.set("type", type);
      fd.set("reason", rejectReason);
      const res = await rejectBatch(null, fd);
      if (res?.error) {
        setRejectError(res.error);
        toastError(res.error);
      } else {
        success(`Lote rechazado (${res?.rejectedCount ?? 0} factura${res?.rejectedCount !== 1 ? "s" : ""})`);
        setShowRejectConfirm(false);
        setRejectReason("");
      }
    });
  };

  if (!readyToClose && !alreadyClosed && rejectableCount === 0) return null;

  return (
    <div className="mt-4 space-y-2.5 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        {readyToClose && !alreadyClosed && (
          <form action={closeAction}>
            <input type="hidden" name="clientId" value={clientId} />
            <input type="hidden" name="month" value={month} />
            <input type="hidden" name="year" value={year} />
            <input type="hidden" name="type" value={type} />
            <button
              type="submit"
              disabled={closePending}
              title="Bloquea el periodo: no se podrán subir ni modificar facturas"
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

        {!alreadyClosed && rejectableCount > 0 && !showRejectConfirm && (
          <button
            type="button"
            onClick={() => setShowRejectConfirm(true)}
            title="Rechaza de golpe todas las facturas del lote (p.ej. se subió por error)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] font-medium text-red-700 hover:bg-red-100"
          >
            <Ban className="h-3.5 w-3.5" />
            Rechazar lote
          </button>
        )}
      </div>

      {showRejectConfirm && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-red-800">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            Vas a rechazar {rejectableCount} factura{rejectableCount !== 1 ? "s" : ""} de este lote. No se borran:
            quedan marcadas como rechazadas y salen del flujo de revisión/export. Esta acción no se deshace desde aquí.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="text"
              required
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Motivo del rechazo (ej: lote subido por error)"
              className="min-w-[220px] flex-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[12px] text-slate-800 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
            />
            <button
              type="button"
              onClick={handleRejectBatch}
              disabled={isRejecting || !rejectReason.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {isRejecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirmar rechazo del lote
            </button>
            <button
              type="button"
              onClick={() => { setShowRejectConfirm(false); setRejectReason(""); setRejectError(null); }}
              className="text-[12px] font-medium text-slate-500 hover:text-slate-700"
            >
              Cancelar
            </button>
          </div>
          {rejectError && <p className="mt-1.5 text-[11px] text-red-700">{rejectError}</p>}
        </div>
      )}
    </div>
  );
}
