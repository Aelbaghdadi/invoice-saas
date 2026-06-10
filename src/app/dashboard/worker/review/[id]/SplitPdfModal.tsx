"use client";

import { useState, useTransition } from "react";
import { X, Scissors, AlertTriangle, Loader2, FileText } from "lucide-react";
import { Document } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { splitPdfInvoice, type PdfSplitPart } from "./actions";

type Props = {
  invoiceId: string;
  pdfUrl: string;
  bucket: string;
  onClose: () => void;
};

type PartConfig = {
  name: string;
  startPage: number;
  endPage: number;
};

function distribuirPaginas(total: number, n: number): PartConfig[] {
  const base = Math.floor(total / n);
  const resto = total % n;
  const parts: PartConfig[] = [];
  let cursor = 1;
  for (let i = 0; i < n; i++) {
    const size = base + (i < resto ? 1 : 0);
    parts.push({
      name: `factura${i + 1}`,
      startPage: cursor,
      endPage: cursor + size - 1,
    });
    cursor += size;
  }
  return parts;
}

export default function SplitPdfModal({ invoiceId, pdfUrl, bucket, onClose }: Props) {
  const [totalPages, setTotalPages] = useState<number>(0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [count, setCount] = useState(2);
  const [parts, setParts] = useState<PartConfig[]>([
    { name: "factura1", startPage: 1, endPage: 1 },
    { name: "factura2", startPage: 2, endPage: 2 },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onPdfLoad({ numPages }: { numPages: number }) {
    setTotalPages(numPages);
    setLoadingPdf(false);
    // Distribuir páginas por defecto
    setParts(distribuirPaginas(numPages, 2));
  }

  function updateCount(n: number) {
    const clamped = Math.max(2, Math.min(20, n));
    setCount(clamped);
    if (totalPages > 0) {
      setParts(distribuirPaginas(totalPages, clamped));
    } else {
      setParts(
        Array.from({ length: clamped }, (_, i) => ({
          name: `factura${i + 1}`,
          startPage: i + 1,
          endPage: i + 1,
        })),
      );
    }
  }

  function updatePart(idx: number, field: keyof PartConfig, value: string | number) {
    setParts((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)),
    );
  }

  function validar(): string | null {
    for (const p of parts) {
      if (!p.name.trim()) return "Todas las partes deben tener un nombre.";
    }
    if (totalPages > 0) {
      for (const p of parts) {
        if (p.startPage < 1 || p.endPage > totalPages) {
          return `"${p.name}": páginas fuera de rango (1–${totalPages}).`;
        }
        if (p.startPage > p.endPage) {
          return `"${p.name}": la página inicial no puede ser mayor que la final.`;
        }
      }
      // Detectar solapamiento
      const sorted = [...parts].sort((a, b) => a.startPage - b.startPage);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startPage <= sorted[i - 1].endPage) {
          return `"${sorted[i].name}" y "${sorted[i - 1].name}" tienen páginas solapadas.`;
        }
      }
    }
    return null;
  }

  function handleSubmit() {
    const err = validar();
    if (err) { setError(err); return; }
    setError(null);

    const splitParts: PdfSplitPart[] = parts.map((p, i) => ({
      name: p.name.trim() || `factura${i + 1}`,
      startPage: p.startPage,
      endPage: p.endPage,
    }));

    startTransition(async () => {
      const result = await splitPdfInvoice(invoiceId, splitParts, bucket);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      {/* Carga silenciosa del PDF para obtener el total de páginas */}
      <div className="hidden">
        <Document file={pdfUrl} onLoadSuccess={onPdfLoad} onLoadError={() => setLoadingPdf(false)} />
      </div>

      <div
        className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Scissors className="h-4.5 w-4.5 text-indigo-600" />
            <span className="text-[15px] font-semibold text-slate-800">
              Dividir PDF en facturas
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <p className="text-[13px] text-slate-500">
            Este PDF contiene varias facturas. Indica cuántas partes hay y asigna a cada una su rango de páginas.
          </p>

          {/* Info páginas */}
          <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
            <FileText className="h-4 w-4 flex-shrink-0 text-slate-400" />
            <span className="text-[13px] text-slate-600">
              {loadingPdf
                ? "Detectando páginas…"
                : totalPages > 0
                  ? `PDF con ${totalPages} página${totalPages > 1 ? "s" : ""}`
                  : "No se pudo detectar el número de páginas"}
            </span>
            {loadingPdf && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
          </div>

          {/* Número de partes */}
          <div className="flex items-center gap-3">
            <label className="w-32 flex-shrink-0 text-[13px] font-medium text-slate-700">
              Nº de facturas
            </label>
            <input
              type="number"
              min={2}
              max={20}
              value={count}
              onChange={(e) => updateCount(parseInt(e.target.value, 10) || 2)}
              className="w-20 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>

          {/* Tabla de partes */}
          <div className="space-y-2.5">
            <div className="grid grid-cols-[1fr_80px_80px] gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Nombre</span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 text-center">Pág. inicio</span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400 text-center">Pág. fin</span>
            </div>
            {parts.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_80px_80px] items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-5 text-right text-[12px] text-slate-400">{i + 1}.</span>
                  <input
                    value={p.name}
                    onChange={(e) => updatePart(i, "name", e.target.value)}
                    className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </div>
                <input
                  type="number"
                  min={1}
                  max={totalPages || 999}
                  value={p.startPage}
                  onChange={(e) => updatePart(i, "startPage", parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-center text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
                <input
                  type="number"
                  min={1}
                  max={totalPages || 999}
                  value={p.endPage}
                  onChange={(e) => updatePart(i, "endPage", parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-center text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex-shrink-0 mx-5 mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending || loadingPdf}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {isPending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Scissors className="h-4 w-4" />
            }
            {isPending ? "Dividiendo…" : "Dividir y añadir a la cola"}
          </button>
        </div>
      </div>
    </div>
  );
}
