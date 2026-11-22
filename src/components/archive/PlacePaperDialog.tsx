"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { BoxProposal, PlaceCount } from "@/lib/tacos";
import { placePaperAction, placePaperProposalAction, previewPlacePaperAction } from "@/app/dashboard/archivo/tacoActions";
import { BoxLabelField } from "./BoxLabelForm";

export type PlacePaperTarget =
  | { invoiceIds: string[] }
  | { clientId: string; fiscalYear: number; paperCount: number; unconfirmedCount: number }
  | { moveInvoiceId: string };

type Destination = "box" | "returned" | "client";

const n = (value: number) => value.toLocaleString("es-ES");

function facturas(count: number): string {
  return `${n(count)} factura${count === 1 ? "" : "s"}`;
}

/** «45 electrónicas y 5 ya en un taco». */
function skippedList(skipped: PlaceCount["skipped"]): string {
  const parts = [
    skipped.electronic > 0 ? `${n(skipped.electronic)} electrónica${skipped.electronic === 1 ? "" : "s"}` : null,
    skipped.inTaco > 0 ? `${n(skipped.inTaco)} ya en un taco` : null,
    skipped.rejected > 0 ? `${n(skipped.rejected)} rechazada${skipped.rejected === 1 ? "" : "s"}` : null,
    skipped.analyzing > 0 ? `${n(skipped.analyzing)} se está${skipped.analyzing === 1 ? "" : "n"} analizando` : null,
  ].filter((part): part is string => part != null);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

function skippedTotalOf(skipped: PlaceCount["skipped"]): number {
  return skipped.electronic + skipped.inTaco + skipped.rejected + skipped.analyzing;
}

/** «Se ubicarán 150 (120 por confirmar pasan a Papel y 30 de papel); 50 se
 *  quedan como están (45 electrónicas y 5 ya en un taco).» */
function previewText(count: PlaceCount): string {
  const skippedTotal = skippedTotalOf(count.skipped);
  if (count.placeable === 0) return `No se puede ubicar ninguna: ${skippedList(count.skipped)}.`;
  const kinds = [
    count.unconfirmed > 0 ? `${n(count.unconfirmed)} por confirmar pasa${count.unconfirmed === 1 ? "" : "n"} a Papel` : null,
    count.paper > 0 ? `${n(count.paper)} de papel` : null,
  ].filter((part): part is string => part != null);
  const placed = `Se ubicará${count.placeable === 1 ? "" : "n"} ${n(count.placeable)} (${kinds.join(" y ")})`;
  if (skippedTotal === 0) return `${placed}.`;
  return `${placed}; ${n(skippedTotal)} se queda${skippedTotal === 1 ? "" : "n"} como está${skippedTotal === 1 ? "" : "n"} (${skippedList(count.skipped)}).`;
}

/**
 * «Poner ubicación» (5.11) sobre una selección o sobre todo lo sin ubicación
 * del ejercicio, o «Sacar del taco» de una factura (5.12). Antes de
 * confirmar dice cuántas se ubicarán y cuántas se quedan como están; la
 * acción lo vuelve a contar con las filas bloqueadas.
 */
export function PlacePaperDialog({
  target,
  clientId,
  fiscalYear,
  onDone,
  onClose,
}: {
  target: PlacePaperTarget;
  clientId: string;
  fiscalYear: number;
  onDone?: () => void;
  onClose: () => void;
}) {
  const scope = "clientId" in target ? target : null;
  const moving = "moveInvoiceId" in target;
  const [includeUnconfirmed, setIncludeUnconfirmed] = useState(scope ? scope.paperCount === 0 : false);
  const [count, setCount] = useState<PlaceCount | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [counting, setCounting] = useState(true);
  const [destination, setDestination] = useState<Destination>("box");
  const [proposal, setProposal] = useState<BoxProposal | null>(null);
  const [loadingProposal, setLoadingProposal] = useState(true);
  const [label, setLabel] = useState("");
  const [newBox, setNewBox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const downOnBackdrop = useRef(false);
  const router = useRouter();
  const { success } = useToast();

  const serverTarget = "clientId" in target
    ? { clientId: target.clientId, fiscalYear: target.fiscalYear, includeUnconfirmed }
    : "moveInvoiceId" in target
      ? { moveInvoiceId: target.moveInvoiceId }
      : { invoiceIds: target.invoiceIds };
  const targetKey = JSON.stringify(serverTarget);

  useEffect(() => {
    let alive = true;
    previewPlacePaperAction({ target: JSON.parse(targetKey) }).then((res) => {
      if (!alive) return;
      setCounting(false);
      if ("error" in res) {
        setCount(null);
        setCountError(res.error);
      } else {
        setCount(res);
        setCountError(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [targetKey]);

  useEffect(() => {
    let alive = true;
    placePaperProposalAction({ clientId, fiscalYear }).then((res) => {
      if (!alive) return;
      setLoadingProposal(false);
      if ("error" in res) return;
      setProposal(res.proposal);
      setLabel((prev) => prev || res.proposal.proposed);
    });
    return () => {
      alive = false;
    };
  }, [clientId, fiscalYear]);

  const title = moving ? "Sacar del taco" : "Poner ubicación";
  const yearLabel = proposal?.fiscalYearLabel ?? String(fiscalYear);
  const subtitle = scope
    ? `Lo que no tiene ubicación del ejercicio ${yearLabel}`
    : facturas("invoiceIds" in target ? target.invoiceIds.length : 1);
  const canSave = !pending && !counting && count != null && count.placeable > 0
    && (destination !== "box" || newBox || label.trim().length > 0);

  const changeInclude = (next: boolean) => {
    setIncludeUnconfirmed(next);
    setCounting(true);
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      const place = destination === "client"
        ? { kind: "client" as const }
        : destination === "returned"
          ? { kind: "returned" as const }
          : newBox
            ? { kind: "newBox" as const }
            : { kind: "box" as const, label };
      const res = await placePaperAction({ target: serverTarget, destination: place });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const placed = facturas(res.placeable);
      const base = destination === "client"
        ? `${placed}: lo tiene el cliente`
        : destination === "returned"
          ? `${placed} devuelta${res.placeable === 1 ? "" : "s"} al cliente`
          : `${placed} en «${res.locationText}»`;
      const skipped = skippedTotalOf(res.skipped);
      success(skipped > 0
        ? `${base} (${n(skipped)} se ha${skipped === 1 ? "" : "n"} quedado como estaba${skipped === 1 ? "" : "n"}).`
        : `${base}.`);
      router.refresh();
      onDone?.();
      onClose();
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget && !pending) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="place-paper-title"
        className="animate-scale-in flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !pending) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 id="place-paper-title" className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
              <MapPin className="h-4 w-4 flex-shrink-0 text-blue-600" />
              {title}
            </h3>
            <p className="mt-0.5 text-[12px] text-slate-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {scope && (
            <div className="space-y-2 rounded-lg bg-slate-50 px-3 py-2.5 text-[12px] text-slate-600">
              <p>
                {n(scope.paperCount)} en papel sin ubicación y {n(scope.unconfirmedCount)} por confirmar.
              </p>
              <label className="flex items-start gap-2 text-[13px] text-slate-700">
                <input
                  type="checkbox"
                  checked={includeUnconfirmed}
                  onChange={(e) => changeInclude(e.target.checked)}
                  disabled={pending}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                Incluir las por confirmar (pasarán a Papel)
              </label>
            </div>
          )}

          <p role="status" className={`text-[12px] ${count && count.placeable === 0 ? "text-amber-700" : "text-slate-600"}`}>
            {counting ? (
              <span className="inline-flex items-center gap-1.5 text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Contando…
              </span>
            ) : countError ? (
              <span className="text-amber-700">{countError}</span>
            ) : count ? previewText(count) : null}
          </p>

          <fieldset className="space-y-3" disabled={pending}>
            <legend className="sr-only">Dónde va el papel</legend>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-[13px] text-slate-700">
                <input
                  type="radio"
                  name="destino-ubicacion"
                  checked={destination === "box"}
                  onChange={() => setDestination("box")}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600"
                />
                <span>
                  <span className="font-medium">En una caja</span>
                  <span className="block text-[11px] text-slate-500">Quedan apuntadas en esa caja como papel ubicado a mano.</span>
                </span>
              </label>
              {destination === "box" && (
                <div className="pl-6">
                  <BoxLabelField
                    id="caja-ubicacion"
                    proposal={proposal}
                    loading={loadingProposal}
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
                name="destino-ubicacion"
                checked={destination === "returned"}
                onChange={() => setDestination("returned")}
                className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600"
              />
              <span>
                <span className="font-medium">Se lo devolvemos hoy</span>
                <span className="block text-[11px] text-slate-500">En la hoja sale una línea para que firme quien lo recoge.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[13px] text-slate-700">
              <input
                type="radio"
                name="destino-ubicacion"
                checked={destination === "client"}
                onChange={() => setDestination("client")}
                className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600"
              />
              <span>
                <span className="font-medium">Lo tiene el cliente</span>
                <span className="block text-[11px] text-slate-500">Nunca nos lo dio, o ya se lo devolvimos antes.</span>
              </span>
            </label>
          </fieldset>

          {error && <p role="alert" className="text-[12px] text-red-600">{error}</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {title}
          </button>
        </div>
      </div>
    </div>
  );
}
