"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, ExternalLink, Layers, Printer, Scissors, X } from "lucide-react";
import { tacoLabel } from "@/lib/paperLocation";
import { BoxLabelForm } from "@/components/archive/BoxLabelForm";
import { ConvertToTacoButton } from "@/components/archive/ConvertToTacoButton";

export type TacoPanel =
  | { kind: "perInvoice"; batchId: string; tacoNumber: number; pageCount: number; uploaded: number; duplicates: number }
  | { kind: "wholePdf"; batchId: string; tacoNumber: number; pageCount: number };

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;
}

const secondaryButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50";

/**
 * La tarjeta del taco al terminar la subida (5.3): cómo ha ido, «Imprimir
 * hoja», «Guardar en caja…» y «Ver el taco»; en el taco entero, «Marcar las
 * facturas». Se queda hasta que se cambia de cliente o se cierra.
 */
export function PaperBatchPanel({ panel, errors, onClose }: { panel: TacoPanel; errors: number; onClose: () => void }) {
  const [filing, setFiling] = useState(false);
  const [filed, setFiled] = useState<{ boxLabel: string | null; returnedAt: string | null } | null>(null);
  const name = tacoLabel(panel.tacoNumber);

  const title = panel.kind === "perInvoice"
    ? `${name} · ${plural(panel.pageCount, "página", "páginas")} (una por factura)`
    : `${name} · ${plural(panel.pageCount, "página", "páginas")} del PDF`;
  const counts = panel.kind === "perInvoice"
    ? [
        panel.uploaded > 0 ? plural(panel.uploaded, "subida", "subidas") : null,
        panel.duplicates > 0 ? plural(panel.duplicates, "duplicada", "duplicadas") : null,
        errors > 0 ? `${errors.toLocaleString("es-ES")} con error` : null,
      ].filter((part): part is string => part != null)
    : [];

  return (
    <section className="rounded-xl border border-blue-200 bg-white p-5 shadow-sm" aria-label={`${name} subido`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
            <Layers className="h-4 w-4 flex-shrink-0 text-blue-600" />
            {title}
          </h2>
          {counts.length > 0 && <p className="mt-1 text-[12px] text-slate-600">{counts.join(" · ")}</p>}
          {panel.kind === "perInvoice" && errors > 0 && (
            <p className="mt-1 text-[12px] text-amber-700">Las páginas con error siguen en la lista: reinténtalas con «Subir».</p>
          )}
          {panel.kind === "wholePdf" && (
            <p className="mt-1 text-[12px] text-amber-700">
              Falta marcar dónde empieza cada factura: hasta entonces no se analiza nada.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          title="Cerrar"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {panel.kind === "wholePdf" && (
          <Link
            href={`/dashboard/archivo/tandas/${panel.batchId}/dividir`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-blue-700"
          >
            <Scissors className="h-3.5 w-3.5" />
            Marcar las facturas
          </Link>
        )}
        <a href={`/imprimir/taco/${panel.batchId}`} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
          <Printer className="h-3.5 w-3.5" />
          Imprimir hoja
        </a>
        {!filing && !filed && (
          <button type="button" onClick={() => setFiling(true)} className={secondaryButton}>
            <Archive className="h-3.5 w-3.5" />
            Guardar en caja…
          </button>
        )}
        <Link href={`/dashboard/archivo/tandas/${panel.batchId}`} className={secondaryButton}>
          <ExternalLink className="h-3.5 w-3.5" />
          Ver el taco
        </Link>
      </div>
      {panel.kind === "perInvoice" && (
        <p className="mt-1.5 text-[11px] text-slate-400">
          La lista con proveedores estará cuando acabe el análisis: vuelve a imprimirla desde Tacos.
        </p>
      )}

      {filed && !filing && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-slate-700">
          <Archive className="h-3.5 w-3.5 text-slate-400" />
          {filed.boxLabel ? `Guardado en «${filed.boxLabel}».` : "Devuelto al cliente hoy."}
          <button type="button" onClick={() => setFiling(true)} className="font-semibold text-blue-700 hover:underline">
            Cambiar
          </button>
        </p>
      )}
      {filing && (
        <div className="mt-4">
          <BoxLabelForm
            batchId={panel.batchId}
            tacoNumber={panel.tacoNumber}
            current={filed ?? undefined}
            onCancel={() => setFiling(false)}
            onDone={(result) => {
              setFiled({ boxLabel: result.boxLabel, returnedAt: result.boxLabel ? null : new Date().toISOString() });
              setFiling(false);
            }}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Tras una subida digital (5.3): «¿Era papel escaneado aquí?», para cuando el
 * gestor se da cuenta de que olvidó marcar «Es papel».
 */
export function DigitalBatchLine({
  batchId,
  fileCount,
  onClose,
}: {
  batchId: string;
  fileCount: number;
  onClose: () => void;
}) {
  const [converted, setConverted] = useState<number | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-[12px] text-slate-600">
      {converted == null ? (
        <>
          <span>Subida de {plural(fileCount, "fichero", "ficheros")}. ¿Era papel escaneado aquí?</span>
          <ConvertToTacoButton batchId={batchId} compact onDone={(result) => setConverted(result.tacoNumber)} />
        </>
      ) : (
        <>
          <span>Ahora es el {tacoLabel(converted)}.</span>
          <a href={`/imprimir/taco/${batchId}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-blue-700 hover:underline">
            Imprimir hoja
          </a>
          <Link href={`/dashboard/archivo/tandas/${batchId}`} className="font-semibold text-blue-700 hover:underline">
            Ver el taco
          </Link>
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar"
        title="Cerrar"
        className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-slate-300 transition hover:bg-slate-100 hover:text-slate-500"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
