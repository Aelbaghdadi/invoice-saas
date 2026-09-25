"use client";

import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCw, ExternalLink } from "lucide-react";
import type { BoundingBox } from "@/lib/boundingBoxes";

const ZOOM_STEPS = [0.5, 0.65, 0.75, 0.9, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

type Props = {
  url: string;
  alt?: string;
  /** Bounding box del campo activo (devuelto por Document AI sobre la
   *  imagen original). Si esta presente, lo dibujamos como overlay
   *  amarillo translucido. Coords normalizadas 0-1. */
  activeBox?: BoundingBox | null;
  /** Enlace "Abrir en pestaña" en la barra. Se quita donde la pantalla ya
   *  tiene el suyo, para no enseñarlo dos veces. */
  showOpenInTab?: boolean;
};

/**
 * Visor de facturas-imagen (JPG / PNG / HEIC...) con zoom, rotacion
 * y resaltado opcional del campo activo. Mismo lenguaje visual que
 * el PdfViewer para que el gestor no tenga que reaprender la toolbar
 * al pasar de un PDF a una foto del movil.
 */
// Zoom inicial al abrir la vista previa: 150%, para que la factura se lea
// sin tener que ampliar a mano cada vez. El usuario puede cambiarlo despues
// con total libertad — no se vuelve a forzar mientras revisa esta factura
// (es solo el valor con el que arranca useState, no un reset periódico).
const DEFAULT_ZOOM = 1.5;

// Padding del lienzo (p-4) por cada lado.
const CANVAS_PADDING = 16;

type Size = { w: number; h: number };

export default function ImageViewer({ url, alt = "Factura", activeBox, showOpenInTab = true }: Props) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [rotation, setRotation] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<Size | null>(null);
  const [natural, setNatural] = useState<(Size & { url: string }) | null>(null);

  // Hueco disponible en el lienzo. Se mide con offsetWidth/offsetHeight
  // (incluyen la barra de scroll) para que la medida no cambie cuando la
  // imagen ampliada hace aparecer el scroll y no entre en bucle.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth - 2 * CANVAS_PADDING;
      const h = el.offsetHeight - 2 * CANVAS_PADDING;
      setCanvas((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el, { box: "border-box" });
    return () => observer.disconnect();
  }, []);

  const zoomIn  = () => setZoom((z) => Math.min(
    ZOOM_STEPS[ZOOM_STEPS.length - 1],
    ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) + 1] ?? z,
  ));
  const zoomOut = () => setZoom((z) => Math.max(
    ZOOM_STEPS[0],
    ZOOM_STEPS[ZOOM_STEPS.findIndex((s) => s >= z) - 1] ?? z,
  ));
  const reset  = () => { setZoom(DEFAULT_ZOOM); setRotation(0); };
  const rotate = () => setRotation((r) => (r + 90) % 360);

  // El zoom se aplica dando a la imagen su tamaño real en pixeles y no con
  // transform: scale(), que no cambia el hueco que ocupa: la foto ampliada
  // se salia por arriba y por la izquierda, donde el scroll no llega (y ahi
  // va el nombre y el NIF del proveedor). 100% = la imagen (ya girada)
  // encaja entera en el lienzo, sin agrandar nunca una imagen pequeña.
  const imageSize = natural?.url === url ? natural : null;
  const sideways = rotation % 180 !== 0;
  let shown: Size | null = null;
  if (imageSize && canvas && canvas.w > 0 && canvas.h > 0) {
    const boxW = sideways ? imageSize.h : imageSize.w;
    const boxH = sideways ? imageSize.w : imageSize.h;
    const fit = Math.min(1, canvas.w / boxW, canvas.h / boxH);
    shown = { w: Math.round(imageSize.w * fit * zoom), h: Math.round(imageSize.h * fit * zoom) };
  }

  const toolButton = "flex h-7 w-7 items-center justify-center rounded-lg text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-30";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#1e1e2e]">
      {/* Toolbar — mismo estilo que PdfViewer. */}
      <div className="flex flex-shrink-0 items-center justify-end border-b border-white/10 bg-[#16161f] px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= ZOOM_STEPS[0]}
            className={toolButton}
            title="Reducir"
            aria-label="Reducir"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={reset}
            className="min-w-[46px] rounded-lg px-2 py-1 text-[12px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white"
            title="Restablecer zoom y rotación"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            className={toolButton}
            title="Ampliar"
            aria-label="Ampliar"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <div className="mx-1 h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={rotate}
            title={`Rotar 90° (actual: ${rotation}°)`}
            className={toolButton}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={reset}
            title="Restablecer zoom y rotación"
            aria-label="Restablecer zoom y rotación"
            className={toolButton}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          {showOpenInTab && (
            <>
              <div className="mx-1 h-4 w-px bg-white/10" />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title="Abrir en pestaña"
                aria-label="Abrir en pestaña"
                className={toolButton}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </>
          )}
        </div>
      </div>

      {/* Lienzo. Con el centrado "safe", si la imagen es mas grande que el
          lienzo se alinea al inicio y el scroll llega a toda ella. */}
      <div
        ref={canvasRef}
        className="flex flex-1 items-center-safe justify-center-safe overflow-auto p-4"
      >
        {/* Caja con el hueco de la imagen ya girada: la rotacion va con
            transform, que no ocupa sitio, y sin esta caja una foto girada
            90° se saldria por los lados. */}
        <div
          className="relative flex-none"
          style={shown ? { width: sideways ? shown.h : shown.w, height: sideways ? shown.w : shown.h } : undefined}
        >
          <div
            className={shown ? "absolute left-1/2 top-1/2" : undefined}
            style={shown ? {
              width: shown.w,
              height: shown.h,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              transition: "transform 120ms ease-out",
            } : undefined}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={alt}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNatural({ url, w: img.naturalWidth, h: img.naturalHeight });
                }
              }}
              className={`block rounded-lg shadow-2xl ${shown ? "h-full w-full" : "max-h-[80vh] max-w-full"}`}
            />
            {/* Highlight del campo activo. Solo lo dibujamos sin rotacion:
                las coordenadas del OCR son en orientacion original; al
                rotar la imagen la caja quedaria desalineada. */}
            {shown && activeBox && rotation === 0 && (
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
    </div>
  );
}
