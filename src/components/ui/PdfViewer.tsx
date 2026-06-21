"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Loader2,
  RotateCw,
} from "lucide-react";
import type { BoundingBox } from "@/lib/boundingBoxes";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const ZOOM_STEPS = [0.5, 0.65, 0.75, 0.9, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0];

// ── Funciones de búsqueda de texto (puras, sin imports de pdfjs) ──────────────

type PdfTextItem = { str: string; pageNum: number; x: number; y: number; w: number; h: number };

function buildSearchCandidates(rawValue: string, field: string): string[] {
  const s = rawValue.trim();
  if (!s) return [];
  const candidates = [s];

  if (["taxBase", "vatAmount", "totalAmount", "vatRate", "irpfRate", "irpfAmount"].includes(field)) {
    const n = parseFloat(s);
    if (!isNaN(n)) {
      const dot2 = n.toFixed(2);
      const com2 = dot2.replace(".", ",");
      const dotN = String(n);
      const comN = dotN.replace(".", ",");
      candidates.push(dot2, com2, dotN, comN);
      candidates.push(dot2 + " €", com2 + " €", dot2 + "€", com2 + "€");
      if (n >= 1000) {
        const thousands = com2.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
        candidates.push(thousands);
      }
    }
  }

  if (field === "invoiceDate" && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-");
    const dd = d.padStart(2, "0");
    const mm = m.padStart(2, "0");
    const di = String(parseInt(d));
    const mi = String(parseInt(m));
    const yy = y.slice(2);
    candidates.push(
      `${dd}/${mm}/${y}`, `${dd}/${mm}/${yy}`,
      `${dd}-${mm}-${y}`, `${dd}-${mm}-${yy}`,
      `${dd}.${mm}.${y}`, `${dd}.${mm}.${yy}`,
      `${di}/${mi}/${y}`, `${di}/${mi}/${yy}`,
    );
  }

  return [...new Set(candidates)];
}

function mergedBox(span: PdfTextItem[]): BoundingBox {
  const x    = Math.min(...span.map((it) => it.x));
  const y    = Math.min(...span.map((it) => it.y));
  const xMax = Math.max(...span.map((it) => it.x + it.w));
  const yMax = Math.max(...span.map((it) => it.y + it.h));
  return { page: span[0].pageNum, x, y, width: xMax - x, height: yMax - y };
}

function searchInPdfItems(target: string, items: PdfTextItem[]): BoundingBox | null {
  const n = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const t = n(target);
  if (!t || t.length < 2) return null;

  for (const it of items) {
    if (n(it.str) === t) return { page: it.pageNum, x: it.x, y: it.y, width: it.w, height: it.h };
  }
  for (const it of items) {
    if (n(it.str).includes(t)) return { page: it.pageNum, x: it.x, y: it.y, width: it.w, height: it.h };
  }
  for (let i = 0; i < items.length; i++) {
    let concat = "";
    const span: PdfTextItem[] = [];
    for (let j = i; j < Math.min(i + 10, items.length); j++) {
      if (items[j].pageNum !== items[i].pageNum) break;
      concat += (j > i ? " " : "") + items[j].str;
      span.push(items[j]);
      if (n(concat).includes(t)) return mergedBox(span);
    }
  }

  return null;
}

// ── Componente ────────────────────────────────────────────────────────────────

type Props = {
  url: string;
  /** Valores de los campos del formulario para localizar en el PDF. */
  fieldValues?: Record<string, string | number | null | undefined>;
  /** ID del campo actualmente enfocado. */
  activeFieldId?: string | null;
  /** Fallback: bbox calculada en servidor (document_ai / gemini_multimodal). */
  activeBox?: BoundingBox | null;
  onTextSelect?: (text: string) => void;
  copyTargetLabel?: string;
};

export default function PdfViewer({
  url,
  fieldValues,
  activeFieldId,
  activeBox,
  onTextSelect,
  copyTargetLabel,
}: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [page, setPage]         = useState(1);
  const [zoom, setZoom]         = useState(1.0);
  const [loading, setLoading]   = useState(true);
  const [rotation, setRotation] = useState(0);

  // Bboxes calculadas en el cliente con pdfjs del navegador (más fiables que
  // las del servidor porque el viewport real ya está disponible).
  const [clientBboxes, setClientBboxes] = useState<Record<string, BoundingBox>>({});

  // La bbox activa: primero buscamos en las calculadas en cliente, luego
  // en el fallback del servidor (document_ai / gemini_multimodal).
  const resolvedActiveBox: BoundingBox | null =
    activeFieldId != null && clientBboxes[activeFieldId]
      ? clientBboxes[activeFieldId]!
      : (activeBox ?? null);

  const computeClientBboxes = useCallback(async (pages: number) => {
    if (!fieldValues || !url) return;
    try {
      // pdfjs del navegador usa el viewport correcto; las coordenadas son exactas.
      const pdfDoc = await pdfjs.getDocument({ url, verbosity: 0 }).promise;
      const allItems: PdfTextItem[] = [];

      for (let pn = 1; pn <= pages; pn++) {
        const p = await pdfDoc.getPage(pn);
        const viewport = p.getViewport({ scale: 1 });
        const vw = viewport.width;
        const vh = viewport.height;
        const content = await p.getTextContent();

        for (const item of content.items as any[]) {
          if (!("str" in item) || !item.str.trim() || !item.width) continue;
          const tx = item.transform[4] as number;
          const ty = item.transform[5] as number;
          const iw = item.width as number;
          const ih = Math.abs(item.height as number) || Math.abs(item.transform[3] as number) || 8;

          const [x1, y1] = viewport.convertToViewportPoint(tx, ty + ih);
          const [x2, y2] = viewport.convertToViewportPoint(tx + iw, ty);

          allItems.push({
            str: item.str,
            pageNum: pn - 1,
            x: Math.max(0, Math.min(1, Math.min(x1, x2) / vw)),
            y: Math.max(0, Math.min(1, Math.min(y1, y2) / vh)),
            w: Math.max(0, Math.min(1, Math.abs(x2 - x1) / vw)),
            h: Math.max(0, Math.min(1, Math.abs(y2 - y1) / vh)),
          });
        }
      }

      const bboxes: Record<string, BoundingBox> = {};
      for (const [field, val] of Object.entries(fieldValues)) {
        if (val == null) continue;
        for (const candidate of buildSearchCandidates(String(val), field)) {
          const box = searchInPdfItems(candidate, allItems);
          if (box) { bboxes[field] = box; break; }
        }
      }
      setClientBboxes(bboxes);
    } catch {
      // Si falla, se usa el fallback del servidor
    }
  }, [url, fieldValues]);

  const onLoad = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setLoading(false);
    computeClientBboxes(n);
  }, [computeClientBboxes]);

  // Navegar a la página del campo activo solo cuando cambia la bbox
  const prevBoxRef = useRef<BoundingBox | null>(null);
  useEffect(() => {
    if (resolvedActiveBox == null) return;
    const prev = prevBoxRef.current;
    const same = prev != null
      && prev.page === resolvedActiveBox.page
      && prev.x === resolvedActiveBox.x
      && prev.y === resolvedActiveBox.y;
    if (same) return;
    prevBoxRef.current = resolvedActiveBox;
    const target = resolvedActiveBox.page + 1;
    if (target >= 1 && target <= numPages) setPage(target);
  }, [resolvedActiveBox, numPages]);

  const zoomIn  = () => setZoom((z) => ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) + 1] ?? z);
  const zoomOut = () => setZoom((z) => ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) - 1] ?? z);
  const reset   = () => setZoom(1.0);
  const rotate  = () => setRotation((r) => (r + 90) % 360);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-white/10 bg-[#16161f] px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {numPages > 1 ? (
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={numPages}
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
                className="w-24 accent-blue-500"
              />
              <span className="min-w-[52px] text-center text-[12px] text-white/60">
                {page} / {numPages}
              </span>
            </div>
          ) : (
            <span className="text-[12px] text-white/40">
              {loading ? "—" : `${numPages} pág.`}
            </span>
          )}

          <button
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            disabled={page >= numPages}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {copyTargetLabel && (
          <div className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2 py-1 text-[11px] text-blue-300">
            <span className="font-mono">→</span>
            <span>{copyTargetLabel}</span>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <button
            onClick={zoomOut}
            disabled={zoom <= ZOOM_STEPS[0]}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            onClick={reset}
            className="min-w-[46px] rounded-lg px-2 py-1 text-[12px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <div className="mx-1 h-4 w-px bg-white/10" />
          <button
            onClick={rotate}
            title={`Rotar 90° (actual: ${rotation}°)`}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={reset}
            title="Restablecer zoom"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* PDF canvas */}
      <div
        className="flex flex-1 items-start justify-center overflow-auto p-6"
        onMouseUp={() => {
          if (!onTextSelect) return;
          const sel = window.getSelection()?.toString().trim();
          if (sel) onTextSelect(sel);
        }}
      >
        {loading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-white/30" />
          </div>
        )}
        <Document
          file={url}
          onLoadSuccess={onLoad}
          loading={null}
          className="flex flex-col items-center gap-4"
        >
          <div className="relative">
            <Page
              pageNumber={page}
              scale={zoom}
              rotate={rotation}
              className="rounded-lg shadow-2xl"
              renderAnnotationLayer
              renderTextLayer
            />
            {resolvedActiveBox && resolvedActiveBox.page === page - 1 && rotation === 0 && (
              <div
                className="pointer-events-none absolute"
                style={{
                  left:   `${resolvedActiveBox.x * 100}%`,
                  top:    `${resolvedActiveBox.y * 100}%`,
                  width:  `${resolvedActiveBox.width * 100}%`,
                  height: `${resolvedActiveBox.height * 100}%`,
                  background: "rgba(253,224,71,0.45)",
                  mixBlendMode: "multiply",
                }}
              />
            )}
          </div>
        </Document>
      </div>
    </div>
  );
}
