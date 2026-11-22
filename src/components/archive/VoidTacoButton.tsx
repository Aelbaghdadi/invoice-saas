"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { tacoLabel } from "@/lib/paperLocation";
import { voidTacoAction } from "@/app/dashboard/archivo/tacoActions";

const REASON_MAX = 200;

/**
 * «Anular el taco…» (B-R22): para un taco subido por error y sin facturas
 * vivas. Solo sale si se puede anular; si cambia entretanto, el diálogo da el
 * error de la acción.
 */
export function VoidTacoButton({ batchId, tacoNumber }: { batchId: string; tacoNumber: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const downOnBackdrop = useRef(false);
  const reasonId = useId();
  const router = useRouter();
  const { success } = useToast();
  const name = tacoLabel(tacoNumber);
  const length = [...reason.trim()].length;

  const close = () => {
    if (pending) return;
    setOpen(false);
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await voidTacoAction({ batchId, reason });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      success(`${name} anulado.`);
      setOpen(false);
      setReason("");
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-red-600 hover:underline"
      >
        <Ban className="h-3.5 w-3.5" />
        Anular el taco…
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
          onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
          onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) close(); }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${reasonId}-titulo`}
            className="animate-scale-in w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <h3 id={`${reasonId}-titulo`} className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 text-red-500" />
              ¿Anular el {name}?
            </h3>
            <p className="mt-1.5 text-[13px] text-slate-500">
              Para un taco subido por error. Se queda con su número y su historia, sale de los avisos y no se puede volver
              a usar. No se borra nada.
            </p>
            <label htmlFor={reasonId} className="mt-4 block text-[12px] font-medium text-slate-600">
              Por qué lo anulas
            </label>
            <textarea
              id={reasonId}
              rows={2}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              autoFocus
              placeholder="Subido al cliente equivocado"
              className="input mt-1 w-full resize-y text-[13px]"
            />
            {error && <p role="alert" className="mt-2 text-[12px] text-red-600">{error}</p>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || length < 2}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Anular el taco
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
