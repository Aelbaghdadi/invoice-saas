"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, CheckCircle2, XCircle, Eye, X, ExternalLink, FileText,
  ChevronLeft, ChevronRight, Zap,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { formatEur } from "@/lib/format";
import { formatDateEs } from "@/lib/dates";
import PdfViewer from "@/components/ui/PdfViewerDynamic";
import ImageViewer from "@/components/ui/ImageViewer";
import { thirdPartyName } from "@/lib/invoiceSort";
import { classifyInvoice, discardUnclassified } from "./actions";

type Candidate = { id: string; name: string };
type Row = {
  id: string;
  filename: string;
  invoiceNumber: string | null;
  type: "PURCHASE" | "SALE";
  /** Subida con «Detectar automáticamente»: `type` es solo un marcador. */
  typeUnconfirmed: boolean;
  issuerName: string | null;
  receiverName: string | null;
  issuerCif: string | null;
  receiverCif: string | null;
  total: number | null;
  date: string | null;
  reason: string | null;
  candidates: Candidate[];
  /** Empresa más probable (regla aprendida o coincidencia de nombre). */
  suggestedClientId: string | null;
};

const REASON_LABEL: Record<string, string> = {
  no_cif: "Sin CIF legible",
  invalid_cif: "CIF no válido (revisar OCR)",
  no_match: "Ningún CIF coincide",
  ambiguous: "Ambiguo (revisar tipo/empresa)",
  periodo_cerrado: "Periodo cerrado",
};

/** La otra parte (el proveedor en una recibida): es lo que el gestor
 *  reconoce del papel. Con el tipo sin determinar se supone recibida. */
function counterpart(row: Row): { name: string | null; cif: string | null } {
  return { name: thirdPartyName(row), cif: row.type === "SALE" ? row.receiverCif : row.issuerCif };
}

function TypeBadge({ row }: { row: Row }) {
  if (row.typeUnconfirmed) return <Badge variant="slate">Sin determinar</Badge>;
  return (
    <Badge variant={row.type === "PURCHASE" ? "blue" : "purple"}>
      {row.type === "PURCHASE" ? "Recibida" : "Emitida"}
    </Badge>
  );
}

export function ClasificarTable({ rows }: { rows: Row[] }) {
  const { success, error: toastError } = useToast();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  // Con la confirmación de descartar abierta, los atajos del carrusel no
  // cuentan: un Enter clasificaba la factura detrás del diálogo.
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [chainIdx, setChainIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, { url: string | null; type: string }>>({});
  const [previewLoading, setPreviewLoading] = useState(false);

  const cur = chainIdx != null ? rows[chainIdx] : null;
  const pendingCount = rows.filter((r) => !done.has(r.id)).length;
  const firstPending = rows.findIndex((r) => !done.has(r.id));

  const close = useCallback(() => {
    setChainIdx(null);
    router.refresh(); // sincroniza la lista (quita las ya clasificadas)
  }, [router]);

  // Avanza a la siguiente pendiente tras marcar `doneId` como hecha.
  const advance = useCallback((doneId: string) => {
    setDone((prev) => {
      const nd = new Set(prev);
      nd.add(doneId);
      let next = -1;
      const from = chainIdx ?? 0;
      for (let i = from + 1; i < rows.length; i++) if (!nd.has(rows[i].id)) { next = i; break; }
      if (next < 0) for (let i = 0; i <= from; i++) if (!nd.has(rows[i].id)) { next = i; break; }
      if (next < 0) { setChainIdx(null); router.refresh(); }
      else setChainIdx(next);
      return nd;
    });
  }, [chainIdx, rows, router]);

  const doClassify = useCallback((clientId: string) => {
    if (!cur || busy || !clientId) return;
    setBusy(true);
    const id = cur.id;
    classifyInvoice(id, clientId)
      .then((res) => {
        if (res?.error) toastError(res.error);
        else { success("Clasificada"); advance(id); }
      })
      // La accion no lanza, pero la red si puede fallar (o caducar la sesion).
      .catch(() => toastError("No se pudo clasificar la factura. Inténtalo de nuevo."))
      .finally(() => setBusy(false));
  }, [cur, busy, advance, success, toastError]);

  const doDiscard = useCallback(async () => {
    if (!cur || busy || confirming) return;
    const id = cur.id;
    setConfirming(true);
    const ok = await confirm({
      title: "¿Descartar esta factura?",
      message: "Se rechaza y sale del reparto para todos: úsalo solo si no es de ninguna de las empresas.",
      confirmLabel: "Descartar",
      tone: "danger",
    });
    setConfirming(false);
    if (!ok) return;
    setBusy(true);
    discardUnclassified(id)
      .then((res) => {
        if (res?.error) toastError(res.error);
        else { success("Descartada"); advance(id); }
      })
      .catch(() => toastError("No se pudo descartar la factura. Inténtalo de nuevo."))
      .finally(() => setBusy(false));
  }, [cur, busy, confirming, confirm, advance, success, toastError]);

  // Solo por las pendientes: una ya clasificada no se puede volver a abrir.
  const goPrev = useCallback(() => {
    if (chainIdx == null) return;
    for (let i = chainIdx - 1; i >= 0; i--) if (!done.has(rows[i].id)) { setChainIdx(i); return; }
  }, [chainIdx, done, rows]);
  const goNext = useCallback(() => {
    if (chainIdx == null) return;
    for (let i = chainIdx + 1; i < rows.length; i++) if (!done.has(rows[i].id)) { setChainIdx(i); return; }
  }, [chainIdx, done, rows]);

  // Cargar vista previa del documento actual.
  useEffect(() => {
    if (!cur || preview[cur.id]) return;
    setPreviewLoading(true);
    fetch(`/api/invoices/${cur.id}/preview`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPreview((p) => ({ ...p, [cur.id]: { url: d.url ?? null, type: d.fileType ?? "" } })))
      .catch(() => setPreview((p) => ({ ...p, [cur.id]: { url: null, type: "" } })))
      .finally(() => setPreviewLoading(false));
  }, [cur, preview]);

  // Atajos de teclado en el carrusel: 1-9 = empresa, Enter = sugerida,
  // D = descartar, ←/→ = navegar, Esc = cerrar.
  useEffect(() => {
    if (chainIdx == null || !cur) return;
    const onKey = (e: KeyboardEvent) => {
      if (busy || confirming) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); goNext(); return; }
      // Enter solo con sugerencia: sin ella asignaba a la primera empresa de
      // la lista, a ciegas.
      if (e.key === "Enter") {
        e.preventDefault();
        if (cur.suggestedClientId) doClassify(cur.suggestedClientId);
        return;
      }
      if (e.key === "d" || e.key === "D") { e.preventDefault(); doDiscard(); return; }
      const n = parseInt(e.key, 10);
      if (!isNaN(n) && n >= 1 && n <= cur.candidates.length) {
        e.preventDefault();
        doClassify(cur.candidates[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chainIdx, cur, busy, confirming, close, goPrev, goNext, doClassify, doDiscard]);

  const nameById = new Map(rows.flatMap((r) => r.candidates.map((c) => [c.id, c.name] as const)));

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[13px] text-slate-500">{pendingCount} factura{pendingCount !== 1 ? "s" : ""} por clasificar</p>
        <button
          type="button"
          onClick={() => firstPending >= 0 && setChainIdx(firstPending)}
          disabled={firstPending < 0}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
        >
          <Zap className="h-4 w-4" /> Clasificar de una en una
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <th className="px-4 py-3">Factura</th>
              <th className="px-4 py-3">Proveedor / cliente</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">CIF de la empresa</th>
              <th className="px-4 py-3">Fecha factura</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Motivo</th>
              <th className="px-4 py-3">Sugerida</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((row, i) => {
              const sideCif = row.type === "PURCHASE" ? row.receiverCif : row.issuerCif;
              const other = counterpart(row);
              const isDone = done.has(row.id);
              return (
                <tr key={row.id} className={`text-[13px] ${isDone ? "text-slate-300" : "text-slate-700 hover:bg-slate-50/60"}`}>
                  <td className="px-4 py-3 max-w-[220px]">
                    <button
                      type="button"
                      onClick={() => setChainIdx(i)}
                      className="flex items-center gap-1.5 truncate text-left text-blue-600 hover:underline disabled:text-slate-300"
                      disabled={isDone}
                    >
                      <Eye className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="truncate">{row.invoiceNumber ?? row.filename}</span>
                    </button>
                    {row.invoiceNumber && <p className="truncate pl-5 text-[11px] text-slate-400" title={row.filename}>{row.filename}</p>}
                  </td>
                  <td className="px-4 py-3 max-w-[220px]">
                    {other.name ? <p className="truncate">{other.name}</p> : <span className="text-slate-400">—</span>}
                    {other.cif && <p className="font-mono text-[11px] text-slate-400">{other.cif}</p>}
                  </td>
                  <td className={`px-4 py-3 ${isDone ? "opacity-40" : ""}`}>
                    <TypeBadge row={row} />
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px]">{sideCif || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDateEs(row.date)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{formatEur(row.total)}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      {REASON_LABEL[row.reason ?? ""] ?? "Por clasificar"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {isDone ? "✓ clasificada" : (row.suggestedClientId ? (nameById.get(row.suggestedClientId) ?? "—") : "—")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setChainIdx(i)}
                      disabled={isDone}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog}
      {cur && (
        <ChainOverlay
          row={cur}
          index={rows.slice(0, chainIdx!).filter((r) => !done.has(r.id)).length}
          total={pendingCount}
          preview={preview[cur.id]}
          previewLoading={previewLoading && !preview[cur.id]}
          busy={busy}
          onClassify={doClassify}
          onDiscard={doDiscard}
          onPrev={goPrev}
          onNext={goNext}
          onClose={close}
        />
      )}
    </>
  );
}

function ChainOverlay({
  row, index, total, preview, previewLoading, busy,
  onClassify, onDiscard, onPrev, onNext, onClose,
}: {
  row: Row;
  index: number;
  total: number;
  preview?: { url: string | null; type: string };
  previewLoading: boolean;
  busy: boolean;
  onClassify: (clientId: string) => void;
  onDiscard: () => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const isImage = (preview?.type ?? "").startsWith("image/");
  const url = preview?.url ?? null;
  const sideCif = row.type === "PURCHASE" ? row.receiverCif : row.issuerCif;
  const other = counterpart(row);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60">
      {/* Cabecera */}
      <div className="flex flex-shrink-0 items-center justify-between gap-3 bg-white px-5 py-3 shadow">
        <div className="flex items-center gap-3 min-w-0">
          <span className="truncate text-[13px] font-semibold text-slate-800">{row.filename}</span>
          <span className="text-[12px] text-slate-400">{index + 1} de {total}</span>
        </div>
        <div className="flex items-center gap-2">
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50">
              <ExternalLink className="h-3.5 w-3.5" /> Pestaña
            </a>
          )}
          <button type="button" onClick={onPrev} title="Anterior (←)" className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={onNext} title="Siguiente (→)" className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={onClose} title="Cerrar (Esc)" className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Documento — mismo visor que la pantalla de revisión (react-pdf /
            ImageViewer). NO usar <iframe>: la CSP (default-src 'self', sin
            frame-src) bloquea cargar el PDF de Supabase en un iframe. */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {previewLoading ? (
            <div className="flex flex-1 items-center justify-center bg-slate-100">
              <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
            </div>
          ) : !url ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-slate-100 text-slate-400">
              <FileText className="h-10 w-10" />
              <p className="text-[13px]">Vista previa no disponible</p>
            </div>
          ) : isImage ? (
            <ImageViewer url={url} alt={row.filename} showOpenInTab={false} />
          ) : (
            <PdfViewer url={url} showOpenInTab={false} />
          )}
        </div>

        {/* Panel de decisión */}
        <div className="flex w-[320px] flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-slate-200 bg-white p-4">
          <div className="space-y-0.5 text-[12px] text-slate-500">
            <div className="mb-1"><TypeBadge row={row} /></div>
            <div>Nº factura: <span className="text-slate-700">{row.invoiceNumber || "—"}</span></div>
            <div>
              {row.type === "SALE" ? "Cliente final" : "Proveedor"}:{" "}
              <span className="text-slate-700">{other.name || "—"}</span>
              {other.cif && <span className="font-mono text-slate-400"> · {other.cif}</span>}
            </div>
            <div>CIF de la empresa: <span className="font-mono text-slate-700">{sideCif || "—"}</span></div>
            <div>Fecha factura: <span className="tabular-nums text-slate-700">{formatDateEs(row.date)}</span></div>
            <div>Total: <span className="tabular-nums text-slate-700">{formatEur(row.total)}</span></div>
            <div className="mt-1">
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                {REASON_LABEL[row.reason ?? ""] ?? "Por clasificar"}
              </span>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">¿A qué empresa?</p>
            {!row.suggestedClientId && row.candidates.length > 0 && (
              <p className="mt-0.5 text-[11px] text-slate-400">Sin sugerencia: pulsa el número de la empresa.</p>
            )}
          </div>
          <div className="space-y-1.5">
            {row.candidates.map((c, i) => {
              const suggested = c.id === row.suggestedClientId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onClassify(c.id)}
                  disabled={busy}
                  className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition disabled:opacity-50 ${
                    suggested ? "border-blue-400 bg-blue-50 text-blue-800" : "border-slate-200 hover:bg-slate-50 text-slate-700"
                  }`}
                >
                  <kbd className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-slate-200 text-[11px] font-semibold text-slate-600">{i + 1}</kbd>
                  <span className="truncate">{c.name}</span>
                  {suggested && <span className="ml-auto text-[10px] font-semibold text-blue-600">sugerida · Enter</span>}
                </button>
              );
            })}
            {row.candidates.length === 0 && (
              <p className="text-[12px] text-slate-400">No tienes empresas accesibles para esta factura.</p>
            )}
          </div>

          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="mt-auto flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            Descartar (D)
          </button>
        </div>
      </div>
    </div>
  );
}
