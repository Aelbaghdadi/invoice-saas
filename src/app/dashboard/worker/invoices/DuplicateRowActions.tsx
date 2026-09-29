"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import {
  quickRejectDuplicate,
  dismissDuplicateIssue,
  type InvoiceQuickAction,
} from "./actions";

/**
 * Acciones inline para una fila con incidencia POSSIBLE_DUPLICATE.
 * Se renderiza solo cuando hay issue abierta de ese tipo.
 *
 *  - "Es duplicada" -> quickRejectDuplicate (rechaza y notifica cliente).
 *                      Pide confirmacion en la propia fila: no se deshace y
 *                      el correo al cliente sale en el acto.
 *  - "No lo es"     -> dismissDuplicateIssue (cierra el issue y vuelve
 *                      la factura a PENDING_REVIEW si procede)
 *
 * Muestra titulito de que estamos resolviendo sin salir del listado.
 */
export function DuplicateRowActions({ invoiceId }: { invoiceId: string }) {
  const { success, error: toastError } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [rejectState, rejectAction, rejectPending] = useActionState<
    InvoiceQuickAction,
    FormData
  >(async (prev, formData) => {
    const result = await quickRejectDuplicate(prev, formData);
    setConfirming(false);
    return result;
  }, null);
  const [dismissState, dismissAction, dismissPending] = useActionState<
    InvoiceQuickAction,
    FormData
  >(dismissDuplicateIssue, null);

  useEffect(() => {
    if (!rejectState) return;
    if (rejectState.error) toastError(rejectState.error);
    else if (rejectState.ok) success("Factura rechazada como duplicada");
  }, [rejectState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dismissState) return;
    if (dismissState.error) toastError(dismissState.error);
    else if (dismissState.ok) success("Incidencia descartada");
  }, [dismissState]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = rejectPending || dismissPending;

  if (confirming) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !rejectPending) {
            e.preventDefault();
            setConfirming(false);
          }
        }}
      >
        <div className="text-[11px] leading-tight">
          <p className="whitespace-nowrap font-medium text-red-800">¿Rechazar como duplicada?</p>
          <p className="whitespace-nowrap text-red-700/80">Se avisará al cliente por correo</p>
        </div>
        <form action={rejectAction}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <button
            type="submit"
            disabled={busy}
            className="inline-flex h-7 items-center gap-1 rounded-lg bg-red-600 px-2 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            {rejectPending && <Loader2 className="h-3 w-3 animate-spin" />}
            Confirmar
          </button>
        </form>
        {/* El foco empieza en Cancelar: un Enter por inercia no rechaza. */}
        <button
          type="button"
          autoFocus
          onClick={() => setConfirming(false)}
          disabled={rejectPending}
          className="h-7 rounded-lg px-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700 disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        title="Es duplicada: rechazar"
        className="inline-flex h-7 items-center gap-1 rounded-lg bg-red-50 px-2 text-[11px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-60"
      >
        <X className="h-3 w-3" />
        Duplicada
      </button>
      <form action={dismissAction}>
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <button
          type="submit"
          disabled={busy}
          title="No es duplicada: descartar incidencia"
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-50 px-2 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
        >
          {dismissPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          No lo es
        </button>
      </form>
    </div>
  );
}
