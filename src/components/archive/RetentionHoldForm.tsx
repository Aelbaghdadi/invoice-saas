"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lightbulb, Loader2, Save } from "lucide-react";
import type { RetentionHoldReason } from "@prisma/client";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { RETENTION_HOLD_LABELS } from "@/lib/originalMedium";
import { setRetentionHoldAction } from "@/app/dashboard/archivo/actions";

const REASONS = Object.entries(RETENTION_HOLD_LABELS).map(([value, label]) => ({ value, label }));
const NOTE_MAX = 500;

export type RetentionHoldValue = { hold: boolean; reason: RetentionHoldReason | null; note: string | null };

/**
 * «Conservar más»: la casilla, el motivo y una nota. En la ficha de una
 * factura, con su valor y la sugerencia de inmovilizado; en una selección de
 * la tabla (`bulk`), para aplicarlo a todas.
 */
export function RetentionHoldForm({
  invoiceIds,
  initial,
  suggested = null,
  bulk = false,
  onDone,
}: {
  invoiceIds: string[];
  initial: RetentionHoldValue;
  /** Lo que se sugiere (compras con cuenta 2xx): no se marca solo. */
  suggested?: RetentionHoldReason | null;
  bulk?: boolean;
  onDone?: () => void;
}) {
  const [hold, setHold] = useState(initial.hold);
  const [reason, setReason] = useState<string>(initial.reason ?? suggested ?? "");
  const [note, setNote] = useState(initial.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const dirty = bulk
    || hold !== initial.hold
    || (hold && (reason !== (initial.reason ?? "") || note.trim() !== (initial.note ?? "")));
  const canSave = dirty && !pending && (!hold || reason !== "");

  const save = () => {
    setError(null);
    startTransition(async () => {
      const res = await setRetentionHoldAction({
        invoiceIds,
        hold,
        reason: hold ? reason : null,
        note: hold ? note.trim() || null : null,
      });
      if ("error" in res) {
        setError(res.error);
        toastError(res.error);
        return;
      }
      const what = hold ? "Se conservará más" : "Ya no se conserva de más";
      success(bulk ? `${what}: ${invoiceIds.length} factura${invoiceIds.length !== 1 ? "s" : ""}` : what);
      router.refresh();
      onDone?.();
    });
  };

  return (
    <div className="space-y-3">
      {suggested && !initial.hold && (
        <div className="flex flex-wrap items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] text-blue-800">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <p className="min-w-0 flex-1">
            Es una compra con cuenta de inmovilizado (grupo 2): se suele conservar mientras se amortiza.
          </p>
          {!(hold && reason === suggested) && (
            <button
              type="button"
              onClick={() => {
                setHold(true);
                setReason(suggested);
              }}
              className="rounded-md bg-white px-2 py-0.5 text-[12px] font-semibold text-blue-700 ring-1 ring-inset ring-blue-200 hover:bg-blue-100"
            >
              Marcar «{RETENTION_HOLD_LABELS[suggested]}»
            </button>
          )}
        </div>
      )}

      <label className="flex items-start gap-2.5 text-[13px] text-slate-700">
        <input
          type="checkbox"
          checked={hold}
          onChange={(e) => setHold(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
        />
        <span>
          <span className="font-medium">Conservar más</span>
          <span className="block text-[11px] text-slate-400">Sin fecha de fin, hasta que alguien lo desmarque.</span>
        </span>
      </label>

      {hold && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`hold-reason-${invoiceIds[0]}`} className="block text-[12px] font-medium text-slate-600">Motivo</label>
            <Select
              id={`hold-reason-${invoiceIds[0]}`}
              size="sm"
              className="mt-1"
              value={reason}
              placeholder="Elige el motivo"
              options={REASONS}
              onChange={setReason}
              searchable={false}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={`hold-note-${invoiceIds[0]}`} className="block text-[12px] font-medium text-slate-600">
              Nota <span className="font-normal text-slate-400">(opcional)</span>
            </label>
            <textarea
              id={`hold-note-${invoiceIds[0]}`}
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="input mt-1 w-full resize-y text-[13px]"
              placeholder="Ej.: furgoneta, se amortiza hasta 2031."
            />
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={!canSave}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {bulk ? `Aplicar a ${invoiceIds.length} factura${invoiceIds.length !== 1 ? "s" : ""}` : "Guardar"}
      </button>
    </div>
  );
}
