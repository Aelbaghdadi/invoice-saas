"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { fiscalQuarterLabel } from "@/lib/archiveRules";

/**
 * «Descargar el ejercicio (ZIP)» (R20), solo para el administrador: el
 * ejercicio entero o un trimestre, todas o solo las registradas, y con o sin
 * las rechazadas. Antes de descargar pregunta si se puede (?check=1): si pasa
 * del límite, el error sale aquí y no como un JSON descargado. Va dentro de
 * una fila flex-wrap: el botón a la derecha y, abierto, en una línea propia.
 */
export function DownloadArchiveZip({
  clientId,
  fiscalYear,
  fiscalYearStartMonth,
}: {
  clientId: string;
  fiscalYear: { startYear: number; label: string };
  fiscalYearStartMonth: number;
}) {
  const [open, setOpen] = useState(false);
  const [quarter, setQuarter] = useState("");
  const [onlyRegistered, setOnlyRegistered] = useState(false);
  const [includeRejected, setIncludeRejected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quarters = [
    { value: "", label: "Todo el ejercicio" },
    ...[1, 2, 3, 4].map((q) => ({ value: String(q), label: fiscalQuarterLabel(fiscalYear.startYear, fiscalYearStartMonth, q) })),
  ];

  async function download() {
    const params = new URLSearchParams({ ejercicio: String(fiscalYear.startYear) });
    if (quarter) params.set("trimestre", quarter);
    if (onlyRegistered) params.set("solo", "registradas");
    else if (includeRejected) params.set("rechazadas", "1");
    const url = `/api/archive/clients/${clientId}/zip?${params}`;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(`${url}&check=1`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No se puede descargar el archivo del ejercicio.");
        return;
      }
      window.location.assign(url);
    } catch {
      setError("No se puede descargar el archivo del ejercicio. Inténtalo de nuevo.");
    } finally {
      setChecking(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 sm:ml-auto"
      >
        <Download className="h-4 w-4 text-slate-400" />
        Descargar el ejercicio (ZIP)
      </button>
    );
  }

  return (
    <div className="w-full basis-full rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
      <p className="text-[13px] font-semibold text-slate-800">Descargar el ejercicio {fiscalYear.label} (ZIP)</p>
      <p className="mt-0.5 text-[12px] text-slate-500">
        Los originales en el orden del archivo, con un índice en Excel. Es lo que se entrega al cliente o a una
        inspección: no lleva notas internas ni datos del personal.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="archivo-zip-trimestre" className="mb-1 block text-[12px] font-medium text-slate-600">Periodo</label>
          <Select id="archivo-zip-trimestre" size="sm" value={quarter} options={quarters} onChange={setQuarter} searchable={false} />
        </div>
        <fieldset>
          <legend className="mb-1 block text-[12px] font-medium text-slate-600">Facturas</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-slate-700">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="archivo-zip-solo" checked={!onlyRegistered} onChange={() => setOnlyRegistered(false)} />
              Todas
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="archivo-zip-solo" checked={onlyRegistered} onChange={() => setOnlyRegistered(true)} />
              Solo las registradas
            </label>
          </div>
          <label className={`mt-1.5 inline-flex items-center gap-1.5 text-[13px] ${onlyRegistered ? "text-slate-400" : "text-slate-700"}`}>
            <input
              type="checkbox"
              checked={includeRejected && !onlyRegistered}
              disabled={onlyRegistered}
              onChange={(e) => setIncludeRejected(e.target.checked)}
            />
            Incluir las rechazadas
          </label>
        </fieldset>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={download}
          disabled={checking}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Descargar
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-lg px-3 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-100"
        >
          Cancelar
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
