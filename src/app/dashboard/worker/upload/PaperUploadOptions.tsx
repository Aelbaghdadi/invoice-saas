"use client";

import { AlertTriangle } from "lucide-react";
import type { PaperBoxMode, PaperScanMode } from "@prisma/client";

const SCAN_OPTIONS: { value: PaperScanMode; label: string; help: string }[] = [
  { value: "PER_INVOICE", label: "Un fichero por factura", help: "Cada fichero es una página del taco, en el orden de la lista." },
  {
    value: "WHOLE_PDF",
    label: "El taco entero en un PDF",
    help: "Un solo PDF con todo el taco. Al subirlo marcarás dónde empieza cada factura.",
  },
];

/**
 * «Es papel escaneado aquí (forma un taco)» y cómo está escaneado (5.2). Sale
 * marcado el modo de escaneo de la asesoría (Ajustes → Papel); el gestor lo
 * puede cambiar en cada subida.
 */
export function PaperUploadOptions({
  isPaper,
  onPaperChange,
  scanMode,
  onScanModeChange,
  classify,
  boxMode,
  disabled,
}: {
  isPaper: boolean;
  onPaperChange: (isPaper: boolean) => void;
  scanMode: PaperScanMode;
  onScanModeChange: (mode: PaperScanMode) => void;
  /** «Clasificar entre varios»: el taco entero no se puede. */
  classify: boolean;
  boxMode: PaperBoxMode;
  disabled: boolean;
}) {
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-3">
      <label className="flex items-start gap-2.5 text-[13px] text-slate-700">
        <input
          type="checkbox"
          checked={isPaper}
          onChange={(e) => onPaperChange(e.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
        />
        <span>
          <span className="font-medium">Es papel escaneado aquí (forma un taco)</span>
          <span className="block text-[11px] text-slate-500">
            Para el papel que os da el cliente y escaneáis en la asesoría. Al terminar podrás imprimir la hoja del taco y
            guardarlo en una caja.
          </span>
        </span>
      </label>

      {isPaper && (
        <fieldset className="space-y-2 pl-6" disabled={disabled}>
          <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Cómo está escaneado
          </legend>
          {SCAN_OPTIONS.map((option) => {
            const blocked = option.value === "WHOLE_PDF" && classify;
            return (
              <label
                key={option.value}
                title={blocked ? "El taco entero se sube a un solo cliente." : undefined}
                className={`flex items-start gap-2 text-[13px] ${blocked ? "text-slate-400" : "text-slate-700"}`}
              >
                <input
                  type="radio"
                  name="modo-escaneo"
                  value={option.value}
                  checked={scanMode === option.value}
                  onChange={() => onScanModeChange(option.value)}
                  disabled={blocked}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600 disabled:opacity-50"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-[11px] text-slate-500">{option.help}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {isPaper && classify && boxMode === "PER_CLIENT_YEAR" && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          Con cajas por cliente, sube el papel de cada cliente en su propio taco: un taco de varios clientes va a una caja
          «Varios clientes».
        </p>
      )}
    </div>
  );
}
