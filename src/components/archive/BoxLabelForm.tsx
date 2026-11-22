"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PackagePlus, Save, Undo2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { tacoLabel } from "@/lib/paperLocation";
import { BOX_LABEL_MAX } from "@/lib/boxProposal";
import type { BoxProposal } from "@/lib/tacos";
import { boxProposalAction, fileTacoAction } from "@/app/dashboard/archivo/tacoActions";

/** La línea de ayuda bajo la caja (5.4): por qué se propone esa. */
function boxHelp(proposal: BoxProposal | null, value: string, newBox: boolean): string | null {
  if (!proposal) return null;
  if (newBox) return "Una caja nueva: al guardar se pone la siguiente que toque.";
  if (proposal.lastUsed && value.trim() === proposal.lastUsed) {
    if (proposal.mode === "SHARED") return "Es la última caja que se usó en la asesoría.";
    return proposal.clientName
      ? `Es la última caja que usasteis para ${proposal.clientName} en ${proposal.fiscalYearLabel}.`
      : `Es la última caja que usasteis para los tacos de varios clientes en ${proposal.fiscalYearLabel}.`;
  }
  if (!proposal.lastUsed && value.trim() === proposal.proposed) return "Todavía no hay ninguna caja: empieza por la 1.";
  return null;
}

/**
 * El campo de la caja: la propuesta, las sugerencias y «Caja nueva» (que
 * enseña la siguiente en solo lectura, con «Deshacer»). Lo usan «Guardar en
 * caja» y «Poner ubicación».
 */
export function BoxLabelField({
  id,
  proposal,
  loading,
  value,
  onChange,
  newBox,
  onNewBox,
  disabled = false,
}: {
  id: string;
  proposal: BoxProposal | null;
  loading: boolean;
  value: string;
  onChange: (value: string) => void;
  newBox: boolean;
  onNewBox: (on: boolean) => void;
  disabled?: boolean;
}) {
  const help = boxHelp(proposal, value, newBox);
  const listId = `${id}-sugerencias`;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="text"
          value={newBox && proposal ? proposal.next : value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={newBox}
          disabled={disabled}
          maxLength={BOX_LABEL_MAX + 20}
          list={listId}
          autoComplete="off"
          placeholder={loading ? "Buscando la última caja…" : "Caja"}
          aria-label="Caja"
          className={`input min-w-0 flex-1 basis-56 text-[13px] ${newBox ? "bg-slate-50 text-slate-600" : ""}`}
        />
        <datalist id={listId}>
          {(proposal?.suggestions ?? []).map((label) => <option key={label} value={label} />)}
        </datalist>
        {newBox ? (
          <button
            type="button"
            onClick={() => onNewBox(false)}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Deshacer
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onNewBox(true)}
            disabled={disabled || !proposal}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            <PackagePlus className="h-3.5 w-3.5" />
            Caja nueva
          </button>
        )}
      </div>
      {help && <p className="text-[11px] text-slate-500">{help}</p>}
    </div>
  );
}

export type BoxLabelDone = { locationText: string; boxLabel: string | null };

/**
 * «Guardar el Taco 37» (5.4): en una caja (con la caja propuesta) o «Se lo
 * devolvemos hoy». En la tarjeta del final de la subida, en el detalle del
 * taco y en la lista de Tacos.
 */
export function BoxLabelForm({
  batchId,
  tacoNumber,
  current,
  onDone,
  onCancel,
}: {
  batchId: string;
  tacoNumber: number;
  current?: { boxLabel: string | null; returnedAt: string | null };
  onDone?: (result: BoxLabelDone) => void;
  onCancel?: () => void;
}) {
  const [proposal, setProposal] = useState<BoxProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"box" | "returned">(current?.returnedAt && !current.boxLabel ? "returned" : "box");
  const [label, setLabel] = useState(current?.boxLabel ?? "");
  const [newBox, setNewBox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { success } = useToast();

  useEffect(() => {
    let alive = true;
    boxProposalAction(batchId).then((res) => {
      if (!alive) return;
      setLoading(false);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setProposal(res.proposal);
      // Lo propuesto solo rellena: lo que ya estaba escrito se queda.
      setLabel((prev) => prev || res.proposal.proposed);
    });
    return () => {
      alive = false;
    };
  }, [batchId]);

  const canSave = !pending && (kind === "returned" || newBox || label.trim().length > 0);

  const save = () => {
    setError(null);
    startTransition(async () => {
      const destination = kind === "returned"
        ? { kind: "returned" as const }
        : newBox
          ? { kind: "newBox" as const }
          : { kind: "box" as const, label };
      const res = await fileTacoAction({ batchId, destination });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      success(res.boxLabel
        ? `${tacoLabel(tacoNumber)} guardado en «${res.boxLabel}».`
        : `${tacoLabel(tacoNumber)}: devuelto al cliente.`);
      router.refresh();
      onDone?.({ locationText: res.locationText, boxLabel: res.boxLabel });
    });
  };

  const fieldId = `caja-${batchId}`;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-[13px] font-semibold text-slate-800">Guardar el {tacoLabel(tacoNumber)}</h3>

      <fieldset className="space-y-3" disabled={pending}>
        <legend className="sr-only">Dónde va el papel</legend>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-[13px] font-medium text-slate-700">
            <input
              type="radio"
              name={`destino-${batchId}`}
              checked={kind === "box"}
              onChange={() => setKind("box")}
              className="h-4 w-4 border-slate-300 text-blue-600"
            />
            En una caja
          </label>
          {kind === "box" && (
            <div className="pl-6">
              <BoxLabelField
                id={fieldId}
                proposal={proposal}
                loading={loading}
                value={label}
                onChange={setLabel}
                newBox={newBox}
                onNewBox={setNewBox}
                disabled={pending}
              />
            </div>
          )}
        </div>
        <label className="flex items-start gap-2 text-[13px] text-slate-700">
          <input
            type="radio"
            name={`destino-${batchId}`}
            checked={kind === "returned"}
            onChange={() => setKind("returned")}
            className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600"
          />
          <span>
            <span className="font-medium">Se lo devolvemos hoy</span>
            <span className="block text-[11px] text-slate-500">En la hoja sale una línea para que firme quien lo recoge.</span>
          </span>
        </label>
      </fieldset>

      {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-slate-200 px-3.5 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
