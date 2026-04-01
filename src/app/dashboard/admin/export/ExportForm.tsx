"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Download, FileDown, CheckCircle2, AlertCircle,
  Loader2,
} from "lucide-react";
import { Select } from "@/components/ui/Select";

type ClientOption = { id: string; name: string; cif: string };

type Props = { clients: ClientOption[] };

const MONTHS = [
  { v: 1,  l: "Enero" },   { v: 2,  l: "Febrero" }, { v: 3,  l: "Marzo" },
  { v: 4,  l: "Abril" },   { v: 5,  l: "Mayo" },    { v: 6,  l: "Junio" },
  { v: 7,  l: "Julio" },   { v: 8,  l: "Agosto" },  { v: 9,  l: "Septiembre" },
  { v: 10, l: "Octubre" }, { v: 11, l: "Noviembre"},{ v: 12, l: "Diciembre" },
];

const FORMATS = [
  { v: "sage50",   l: "Sage 50",   desc: "Sage 50 España — diario de facturas" },
  { v: "contasol", l: "Contasol",  desc: "Contasol — importación de IVA"       },
  { v: "a3con",    l: "a3con",     desc: "a3 Software — facturas recibidas/emitidas" },
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
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [month,    setMonth]    = useState(now.getMonth() + 1);
  const [year,     setYear]     = useState(THIS_YEAR);
  const [type,     setType]     = useState("ALL");
  const [format,   setFormat]   = useState("sage50");

  const [count,    setCount]    = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [success,  setSuccess]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // ── fetch preview count ─────────────────────────────────────────────────
  const fetchCount = useCallback(async () => {
    if (!clientId) return;
    setCounting(true);
    setSuccess(false);
    setError(null);
    try {
      const sp = new URLSearchParams({
        clientId, month: String(month), year: String(year),
        type, format, preview: "1",
      });
      const res  = await fetch(`/api/export?${sp}`);
      const data = await res.json();
      setCount(data.count ?? 0);
    } catch {
      setCount(null);
    } finally {
      setCounting(false);
    }
  }, [clientId, month, year, type, format]);

  useEffect(() => { fetchCount(); }, [fetchCount]);

  // ── download ────────────────────────────────────────────────────────────
  const handleDownload = async () => {
    if (!count) return;
    const sp = new URLSearchParams({
      clientId, month: String(month), year: String(year), type, format,
    });
    // Trigger file download
    const a = document.createElement("a");
    a.href = `/api/export?${sp}`;
    a.click();
    setSuccess(true);
    // Refresh count (they'll now be EXPORTED)
    setTimeout(() => { fetchCount(); setSuccess(false); }, 2500);
  };

  const selectedClient = clients.find((c) => c.id === clientId);
  const selectedFormat = FORMATS.find((f) => f.v === format);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* ── LEFT: filters ────────────────────────────────────────────────── */}
      <div className="lg:col-span-3 space-y-5">

        {/* Client */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Cliente
          </p>
          <Select
            value={clientId}
            onChange={setClientId}
            options={clients.map((c) => ({ value: c.id, label: `${c.name} — ${c.cif}` }))}
          />
        </div>

        {/* Period */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Período
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Select
              value={String(month)}
              onChange={(v) => setMonth(Number(v))}
              options={MONTHS.map((m) => ({ value: String(m.v), label: m.l }))}
            />
            <Select
              value={String(year)}
              onChange={(v) => setYear(Number(v))}
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
            />
          </div>
        </div>

        {/* Type */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Tipo de factura
          </p>
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setType(t.v)}
                className={`flex-1 rounded-xl border px-3 py-2 text-[12px] font-medium transition ${
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
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Software contable destino
          </p>
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <button
                key={f.v}
                type="button"
                onClick={() => setFormat(f.v)}
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
              <Row label="Período"   value={`${MONTHS.find(m => m.v === month)?.l} ${year}`} />
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
                No hay facturas exportables con estos filtros.
              </p>
            )}
          </div>

          {/* Status messages */}
          {success && (
            <div className="flex items-center gap-2 rounded-xl bg-green-50 px-4 py-3 text-[13px] text-green-700">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              Exportación completada. Las facturas han sido marcadas como Exportadas.
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Download button */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={!count || counting || count === 0}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-blue-600 px-5 py-3.5 text-[14px] font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            Descargar CSV
            {count != null && count > 0 && (
              <span className="rounded-full bg-blue-500 px-2 py-0.5 text-[11px]">
                {count}
              </span>
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
