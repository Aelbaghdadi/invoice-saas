"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, ExternalLink, FilePlus2, Printer, Scissors } from "lucide-react";
import { BoxLabelForm } from "@/components/archive/BoxLabelForm";
import { ConvertToTacoButton } from "@/components/archive/ConvertToTacoButton";
import { TacoCompleteUpload } from "@/components/archive/TacoCompleteUpload";
import { VoidTacoButton } from "@/components/archive/VoidTacoButton";
import type { UploadMeta } from "@/lib/uploadDirectClient";

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50";

export type TacoDetailActionsProps = {
  batchId: string;
  tacoNumber: number | null;
  /** Guardar o cambiar de caja (un taco sin anular). */
  canFile: boolean;
  filed: boolean;
  current: { boxLabel: string | null; returnedAt: string | null };
  canSplit: boolean;
  tacoPdfUrl: string | null;
  canConvert: boolean;
  canVoid: boolean;
  /** «Completar el taco»: lo que necesita la subida, o null si no se completa. */
  complete: {
    fileCount: number;
    occupied: { position: number; fileHash: string }[];
    takenPages: number[];
    meta: UploadMeta;
  } | null;
};

/**
 * Los botones del detalle de una tanda o taco (5.7), según el caso: guardar
 * en caja, imprimir la hoja, marcar las facturas de un taco entero, ver su
 * PDF, completar el taco, «Era papel» y, al final y discreto, anular.
 */
export function TacoDetailActions(props: TacoDetailActionsProps) {
  const [panel, setPanel] = useState<"file" | "complete" | null>(null);
  const { batchId, tacoNumber } = props;
  const toggle = (next: "file" | "complete") => setPanel((open) => (open === next ? null : next));

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.canFile && tacoNumber != null && (
          <button type="button" aria-expanded={panel === "file"} onClick={() => toggle("file")} className={buttonClass}>
            <Archive className="h-4 w-4 text-slate-400" />
            {props.filed ? "Cambiar de caja…" : "Guardar en caja…"}
          </button>
        )}
        {tacoNumber != null && (
          <a href={`/imprimir/taco/${batchId}`} target="_blank" rel="noopener" className={buttonClass}>
            <Printer className="h-4 w-4 text-slate-400" />
            Imprimir hoja
          </a>
        )}
        {props.canSplit && (
          <Link
            href={`/dashboard/archivo/tandas/${batchId}/dividir`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-amber-700"
          >
            <Scissors className="h-4 w-4" />
            Marcar dónde empieza cada factura
          </Link>
        )}
        {props.tacoPdfUrl && (
          <a href={props.tacoPdfUrl} target="_blank" rel="noopener" className={buttonClass}>
            <ExternalLink className="h-4 w-4 text-slate-400" />
            Ver el PDF del taco entero
          </a>
        )}
        {props.complete && tacoNumber != null && (
          <button type="button" aria-expanded={panel === "complete"} onClick={() => toggle("complete")} className={buttonClass}>
            <FilePlus2 className="h-4 w-4 text-slate-400" />
            Completar el taco
          </button>
        )}
        {props.canConvert && <ConvertToTacoButton batchId={batchId} />}
        {props.canVoid && tacoNumber != null && (
          <span className="sm:ml-auto">
            <VoidTacoButton batchId={batchId} tacoNumber={tacoNumber} />
          </span>
        )}
      </div>

      {panel === "file" && tacoNumber != null && (
        <div className="max-w-lg">
          <BoxLabelForm
            batchId={batchId}
            tacoNumber={tacoNumber}
            current={props.current}
            onDone={() => setPanel(null)}
            onCancel={() => setPanel(null)}
          />
        </div>
      )}
      {panel === "complete" && props.complete && tacoNumber != null && (
        <TacoCompleteUpload
          batchId={batchId}
          tacoNumber={tacoNumber}
          fileCount={props.complete.fileCount}
          occupied={props.complete.occupied}
          takenPages={props.complete.takenPages}
          meta={props.complete.meta}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
