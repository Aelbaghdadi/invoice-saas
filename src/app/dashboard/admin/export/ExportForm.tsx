"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Download, FileDown, CheckCircle2,
  Loader2, AlertTriangle,
} from "lucide-react";
import type { A3ValidationWarning as A3Warning } from "@/lib/exportFormats";
import { Select } from "@/components/ui/Select";
import { ErrorBox } from "@/components/ui/ErrorBox";
import type { AppError } from "@/lib/errorCodes";
import { quarterStartMonth, periodLabel, MONTH_OPTIONS, QUARTER_OPTIONS } from "@/lib/period";

type ClientOption = { id: string; name: string; cif: string };

type Props = { clients: ClientOption[] };

const FORMATS = [
  { v: "a3excel",  l: "A3 Excel",  desc: "A3 Asesor — Excel con cuentas contables (.xlsx)" },
];

const TYPES = [
  { v: "ALL",      l: "Todas" },
  { v: "PURCHASE", l: "Recibidas (compras)" },
  { v: "SALE",     l: "Emitidas (ventas)" },
];

const now = new Date();
const THIS_YEAR  = now.getFullYear();
const YEARS      = Array.from({ length: 5 }, (_, i) => THIS_YEAR - i);


export function ExportForm({ clients }: Props) {
  const [clientId,   setClientId]   = useState(clients[0]?.id ?? "");
  const [periodType, setPeriodType] = useState<"MONTHLY" | "QUARTERLY">("MONTHLY");
  const [month,      setMonth]      = useState(now.getMonth() + 1);
  const [quarter,    setQuarter]    = useState(Math.ceil((now.getMonth() + 1) / 3));
  const [year,       setYear]       = useState(THIS_YEAR);
  const [type,       setType]       = useState("ALL");
  const [format,     setFormat]     = useState("a3excel");

  const [count,    setCount]    = useState<number | null>(null);
  // Avisos de validacion A3 (NIF vacio, descuadres, tipo de operacion que no
  // corresponde al sentido...). Se recortan a 20 en el servidor.
  const [warnings,     setWarnings]     = useState<A3Warning[]>([]);
  const [warningCount, setWarningCount] = useState(0);
  // Facturas del periodo que ya salieron en un Excel anterior: no se vuelven
  // a incluir, pero hay que decirlo o el recuento no se entiende.
  const [alreadyExported, setAlreadyExported] = useState(0);
  const [counting, setCounting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [success,  setSuccess]  = useState(false);
  const [error,    setError]    = useState<AppError | string | null>(null);

  // ── fetch preview count ─────────────────────────────────────────────────
  const effectiveMonth = periodType === "QUARTERLY" ? quarterStartMonth(quarter) : month;

  // keepMessages: tras una descarga se relee el recuento sin borrar el aviso
  // de exito o de error que acaba de ponerse; al cambiar filtros si se borran.
  const fetchCount = useCallback(async (keepMessages = false) => {
    if (!clientId) return;
    setCounting(true);
    if (!keepMessages) {
      setSuccess(false);
      setError(null);
    }
    try {
      const sp = new URLSearchParams({
        clientId,
        periodType,
        month: String(effectiveMonth),
        year: String(year),
        type, format, preview: "1",
      });
      const res  = await fetch(`/api/export?${sp}`);
      const data = await res.json();
      setCount(data.count ?? 0);
      setWarnings(data.warnings ?? []);
      setWarningCount(data.warningCount ?? 0);
      setAlreadyExported(data.alreadyExported ?? 0);
    } catch {
      setCount(null);
      setWarnings([]);
      setWarningCount(0);
    } finally {
      setCounting(false);
    }
  }, [clientId, periodType, effectiveMonth, year, type, format]);

  useEffect(() => { fetchCount(); }, [fetchCount]);

  // ── download ────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    // Sin este freno, un doble clic creaba dos lotes con las mismas facturas
    // (asientos duplicados en A3) o sacaba el error de "nada que exportar".
    if (!count || downloading) return;
    const sp = new URLSearchParams({
      clientId, periodType, month: String(effectiveMonth), year: String(year), type, format,
    });
    // Se descarga con fetch y NO con un <a href>: al exportar, el servidor
    // marca las facturas como exportadas, y con el enlace a secas un fallo
    // (500, sesion caducada, 404 por filtros) se anunciaba igual como exito.
    // El gestor se quedaba sin fichero y sin poder volver a sacar esas
    // facturas, porque ya constaban exportadas.
    setError(null);
    setSuccess(false);
    setDownloading(true);
    try {
      const res = await fetch(`/api/export?${sp}`);
      if (!res.ok) {
        let failure: AppError | string = "No se ha podido generar el Excel. Vuelve a intentarlo.";
        try {
          const data = await res.json();
          // La API devuelve {code, message, details}: con String() salia "[object Object]".
          if (typeof data?.error === "string") failure = data.error;
          else if (data?.error?.message) failure = data.error as AppError;
        } catch { /* la respuesta no era JSON: se queda el mensaje generico */ }
        setError(failure);
        fetchCount(true);
        return;
      }
      const blob = await res.blob();
      // Nombre del fichero que propone el servidor (Content-Disposition).
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match ? decodeURIComponent(match[1]) : "export.xlsx";
      a.click();
      URL.revokeObjectURL(url);
      setSuccess(true);
      // Las descargadas ya constan exportadas: se refresca el recuento ya,
      // no a los 2,5 s, o el boton seguia ofreciendo las mismas facturas.
      fetchCount(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch {
      setError("Error de conexión al generar el Excel. Comprueba si se ha descargado antes de repetirlo.");
      fetchCount(true);
    } finally {
      setDownloading(false);
    }
  };

  const selectedClient = clients.find((c) => c.id === clientId);
  const selectedFormat = FORMATS.find((f) => f.v === format);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* ── LEFT: filters ────────────────────────────────────────────────── */}
      <div className="lg:col-span-3 space-y-5">

        {/* Client */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label htmlFor="export-client" className="mb-3 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Cliente
          </label>
          <Select
            id="export-client"
            value={clientId}
            onChange={setClientId}
            options={clients.map((c) => ({ value: c.id, label: `${c.name} — ${c.cif}` }))}
          />
        </div>

        {/* Period */}
        <div role="group" aria-labelledby="export-period-label" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p id="export-period-label" className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Periodo
          </p>
          {/* Toggle mensual / trimestral */}
          <div className="mb-3 flex gap-2">
            {(["MONTHLY", "QUARTERLY"] as const).map((pt) => (
              <button
                key={pt}
                type="button"
                onClick={() => setPeriodType(pt)}
                aria-pressed={periodType === pt}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition ${
                  periodType === pt
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {pt === "MONTHLY" ? "Mensual" : "Trimestral"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {periodType === "MONTHLY" ? (
              <Select
                id="export-month"
                aria-label="Mes"
                value={String(month)}
                onChange={(v) => setMonth(Number(v))}
                options={MONTH_OPTIONS}
              />
            ) : (
              <Select
                id="export-quarter"
                aria-label="Trimestre"
                value={String(quarter)}
                onChange={(v) => setQuarter(Number(v))}
                options={QUARTER_OPTIONS.map((q) => ({ value: String(q.value), label: q.label }))}
              />
            )}
            <Select
              id="export-year"
              aria-label="Año"
              value={String(year)}
              onChange={(v) => setYear(Number(v))}
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
            />
          </div>
        </div>

        {/* Type */}
        <div role="group" aria-labelledby="export-type-label" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p id="export-type-label" className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Tipo de factura
          </p>
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setType(t.v)}
                aria-pressed={type === t.v}
                className={`flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition ${
                  type === t.v
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {t.l}
              </button>
            ))}
          </div>
        </div>

        {/* Format */}
        <div role="group" aria-labelledby="export-format-label" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p id="export-format-label" className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Software contable destino
          </p>
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <button
                key={f.v}
                type="button"
                onClick={() => setFormat(f.v)}
                aria-pressed={format === f.v}
                className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                  format === f.v
                    ? "border-blue-500 bg-blue-50"
                    : "border-slate-100 hover:bg-slate-50"
                }`}
              >
                <div className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded-full border-2 transition ${
                  format === f.v ? "border-blue-500 bg-blue-500" : "border-slate-300"
                }`} />
                <div>
                  <p className={`text-[13px] font-semibold ${format === f.v ? "text-blue-700" : "text-slate-700"}`}>
                    {f.l}
                  </p>
                  <p className="text-[11px] text-slate-400">{f.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── RIGHT: preview + download ───────────────────────────────────── */}
      <div className="lg:col-span-2">
        <div className="sticky top-6 space-y-4">

          {/* Summary card */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50">
                <FileDown className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-slate-800">Resumen de exportación</p>
                <p className="text-[12px] text-slate-400">{selectedFormat?.l}</p>
              </div>
            </div>

            <div className="space-y-3 text-[13px]">
              <Row label="Cliente"   value={selectedClient?.name ?? "—"} />
              <Row label="Periodo"   value={periodLabel(periodType, effectiveMonth, year)} />
              <Row label="Tipo"      value={TYPES.find(t => t.v === type)?.l ?? "—"} />
              <Row label="Formato"   value={selectedFormat?.l ?? "—"} />
            </div>

            {/* Count */}
            <div className={`mt-5 flex items-center justify-between rounded-xl px-4 py-3 ${
              count === 0 ? "bg-amber-50" : "bg-slate-50"
            }`}>
              <span className="text-[12px] font-medium text-slate-500">Facturas exportables</span>
              {counting ? (
                <Loader2 className="h-4 w-4 animate-spin text-slate-300" />
              ) : (
                <span className={`text-[20px] font-bold ${
                  count === 0 ? "text-amber-500" : "text-slate-800"
                }`}>
                  {count ?? "—"}
                </span>
              )}
            </div>

            {count === 0 && !counting && (
              <p className="mt-2 text-center text-[12px] text-amber-600">
                {alreadyExported > 0
                  ? `Todas las facturas de este periodo (${alreadyExported}) ya se exportaron antes. Solo vuelven a salir si las corriges en la revisión.`
                  : "No hay facturas exportables con estos filtros."}
              </p>
            )}
            {count !== 0 && alreadyExported > 0 && !counting && (
              <p className="mt-2 text-center text-[12px] text-slate-400">
                {alreadyExported === 1
                  ? "Otra factura de este periodo ya se exportó antes y no se repite."
                  : `Otras ${alreadyExported} facturas de este periodo ya se exportaron antes y no se repiten.`}
              </p>
            )}
          </div>

          {/* Avisos de validación A3: la última oportunidad de ver un error
              antes de que el fichero entre en la contabilidad del cliente. */}
          {warningCount > 0 && !counting && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {warningCount === 1
                  ? "1 factura con avisos"
                  : `${warningCount} facturas con avisos`}
              </p>
              <ul className="mt-2 space-y-1.5">
                {warnings.map((w) => (
                  <li key={w.invoiceId} className="text-[12px] text-amber-700">
                    {/* Enlace a la revision: una validada se puede corregir mientras
                        el periodo no este cerrado, y sin enlace habia que buscarla a mano. */}
                    <Link
                      href={`/dashboard/worker/review/${w.invoiceId}`}
                      className="font-medium underline decoration-amber-300 underline-offset-2 hover:text-amber-900"
                    >
                      {w.invoiceNumber || "Sin número"}
                    </Link>
                    {" — "}
                    {w.warnings.join("; ")}
                  </li>
                ))}
              </ul>
              {warningCount > warnings.length && (
                <p className="mt-2 text-[11px] text-amber-600">
                  Y {warningCount - warnings.length} más. Se exportan igualmente: los avisos no bloquean.
                </p>
              )}
            </div>
          )}

          {/* Status messages */}
          {success && (
            <div className="flex items-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-[13px] text-green-700">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              Exportación completada. Las facturas han sido marcadas como Exportadas.
            </div>
          )}
          {error && <ErrorBox error={error} variant="banner" />}

          {/* Download button */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!count || counting || count === 0 || downloading}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-blue-600 px-5 py-3.5 text-[14px] font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generando Excel…
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Descargar Excel
                {count != null && count > 0 && (
                  <span className="rounded-full bg-blue-500 px-2 py-0.5 text-[11px]">
                    {count}
                  </span>
                )}
              </>
            )}
          </button>

          <p className="text-center text-[11px] text-slate-400">
            Al descargar, las facturas pasarán al estado <strong>Exportada</strong>
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700 truncate max-w-[160px]">{value}</span>
    </div>
  );
}
