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

type Props = {
  url: string;
  activeBox?: BoundingBox | null;
  /** Llamado cuando el usuario suelta el ratón con texto seleccionado. */
  onTextSelect?: (text: string) => void;
  /** Etiqueta del campo que recibirá el texto (para el hint en toolbar). */
  copyTargetLabel?: string;
};

export default function PdfViewer({ url, activeBox, onTextSelect, copyTargetLabel }: Props) {
  const [numPages, setNumPages] = useState<number>(0);
  const [page, setPage]         = useState(1);
  const [zoom, setZoom]         = useState(1.0);
  const [loading, setLoading]   = useState(true);
  // Rotacion en grados (0, 90, 180, 270) para facturas escaneadas
  // boca abajo o de lado. Se aplica a la pagina entera via react-pdf.
  const [rotation, setRotation] = useState(0);

  // Solo navegamos cuando el campo activo CAMBIA a uno diferente.
  // Si el usuario re-enfoca el mismo campo y ya navegó manualmente a
  // otra página, no le arrancamos de allí.
  const prevActiveBoxRef = useRef<typeof activeBox>(null);
  useEffect(() => {
    if (activeBox == null) { prevActiveBoxRef.current = null; return; }
    const prev = prevActiveBoxRef.current;
    const sameBox = prev != null
      && prev.page === activeBox.page
      && prev.x === activeBox.x
      && prev.y === activeBox.y;
    if (sameBox) return;
    prevActiveBoxRef.current = activeBox;
    const target = activeBox.page + 1; // Document AI usa 0-indexed
    if (target >= 1 && target <= numPages) setPage(target);
  }, [activeBox, numPages]);

  const onLoad = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setLoading(false);
  }, []);

  const zoomIn  = () => setZoom((z) => Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) + 1] ?? z));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) - 1] ?? z));
  const reset   = () => setZoom(1.0);
  const rotate  = () => setRotation((r) => (r + 90) % 360);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-white/10 bg-[#16161f] px-4 py-2">
        {/* Page navigation */}
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

        {/* Hint campo destino */}
        {copyTargetLabel && (
          <div className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2 py-1 text-[11px] text-blue-300">
            <span className="font-mono">→</span>
            <span>{copyTargetLabel}</span>
          </div>
        )}

        {/* Zoom */}
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
            {/* Bounding box del campo activo. Solo lo dibujamos sin rotacion:
                las coordenadas del OCR son en orientacion original; al rotar
                la pagina la caja quedaria desalineada. */}
            {activeBox && activeBox.page === page - 1 && rotation === 0 && (
              <div
                className="pointer-events-none absolute"
                style={{
                  left:   `${activeBox.x * 100}%`,
                  top:    `${activeBox.y * 100}%`,
                  width:  `${activeBox.width * 100}%`,
                  height: `${activeBox.height * 100}%`,
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
