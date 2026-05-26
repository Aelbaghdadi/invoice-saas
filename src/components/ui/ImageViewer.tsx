"use client";

import { useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCw } from "lucide-react";
import type { BoundingBox } from "@/lib/boundingBoxes";

const ZOOM_STEPS = [0.5, 0.65, 0.75, 0.9, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

type Props = {
  url: string;
  alt?: string;
  /** Bounding box del campo activo (devuelto por Document AI sobre la
   *  imagen original). Si esta presente, lo dibujamos como overlay
   *  amarillo translucido. Coords normalizadas 0-1. */
  activeBox?: BoundingBox | null;
};

/**
 * Visor de facturas-imagen (JPG / PNG / HEIC...) con zoom, rotacion
 * y resaltado opcional del campo activo. Mismo lenguaje visual que
 * el PdfViewer para que el gestor no tenga que reaprender la toolbar
 * al pasar de un PDF a una foto del movil.
 */
export default function ImageViewer({ url, alt = "Factura", activeBox }: Props) {
  const [zoom, setZoom] = useState(1.0);
  const [rotation, setRotation] = useState(0);

  const zoomIn  = () => setZoom((z) => Math.min(
    ZOOM_STEPS[ZOOM_STEPS.length - 1],
    ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) + 1] ?? z,
  ));
  const zoomOut = () => setZoom((z) => Math.max(
    ZOOM_STEPS[0],
    ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) - 1] ?? z,
  ));
  const reset  = () => { setZoom(1.0); setRotation(0); };
  const rotate = () => setRotation((r) => (r + 90) % 360);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      {/* Toolbar — mismo estilo que PdfViewer. */}
      <div className="flex flex-shrink-0 items-center justify-end border-b border-white/10 bg-[#16161f] px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={zoomOut}
            disabled={zoom <= ZOOM_STEPS[0]}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            title="Reducir"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            onClick={reset}
            className="min-w-[46px] rounded-lg px-2 py-1 text-[12px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            title="Restablecer zoom y rotación"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
            title="Ampliar"
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
            title="Restablecer zoom y rotación"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Canvas de la imagen. La imagen siempre encaja en el contenedor
          a zoom 1.0 (object-contain + max-h-full max-w-full). El zoom y
          la rotacion se aplican con transform sobre ese tamano "fit",
          asi una foto de movil de 3000x4000 se ve completa de entrada
          y desde ahi se hace zoom para detalle. */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <div
          className="relative inline-block max-h-full max-w-full"
          style={{
            transform: `scale(${zoom}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
            transition: "transform 120ms ease-out",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={alt}
            className="block max-h-[80vh] max-w-full rounded-lg shadow-2xl"
          />
          {/* Highlight del campo activo. Solo lo dibujamos sin rotacion:
              las coordenadas del OCR son en orientacion original; al
              rotar la imagen la caja quedaria desalineada. */}
          {activeBox && rotation === 0 && (
            <div
              className="pointer-events-none absolute rounded-sm"
              style={{
                left:         `${activeBox.x * 100}%`,
                top:          `${activeBox.y * 100}%`,
                width:        `${activeBox.width * 100}%`,
                height:       `${activeBox.height * 100}%`,
                background:   "rgba(253,224,71,0.45)",
                mixBlendMode: "multiply",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
