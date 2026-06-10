"use client";

import { useState, useRef, useCallback, useTransition, useEffect } from "react";
import { X, Scissors, ChevronRight, ChevronLeft, Check, Loader2, AlertTriangle, Crop } from "lucide-react";
import { splitInvoice, type SplitTicket } from "./actions";

type Props = {
  invoiceId: string;
  imageUrl: string;
  bucket: string;
  onClose: () => void;
};

type CropRect = { x: number; y: number; w: number; h: number } | null;

type TicketConfig = {
  name: string;
  crop: CropRect;
};

// Paso 1: configurar cuántos tickets y sus nombres.
// Paso 2: recortar cada ticket de la imagen original.
type Step = "configure" | "crop";

export default function SplitInvoiceModal({ invoiceId, imageUrl, bucket, onClose }: Props) {
  const [step, setStep] = useState<Step>("configure");
  const [count, setCount] = useState(2);
  const [tickets, setTickets] = useState<TicketConfig[]>([
    { name: "ticket1", crop: null },
    { name: "ticket2", crop: null },
  ]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── Precarga de la imagen como blob (evita tainted canvas cross-origin) ──

  // objectURL creado a partir del blob de la imagen. Se usa como src del
  // <img> para que el canvas pueda leer los píxeles sin restricción CORS.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobLoading, setBlobLoading] = useState(false);

  useEffect(() => {
    if (step !== "crop" || blobUrl) return;
    setBlobLoading(true);
    fetch(imageUrl)
      .then((r) => r.blob())
      .then((blob) => {
        setBlobUrl(URL.createObjectURL(blob));
      })
      .catch(() => setError("No se pudo cargar la imagen para el recorte."))
      .finally(() => setBlobLoading(false));

    return () => {
      // Limpiar el objectURL al desmontar para liberar memoria
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ── Lógica de recorte ────────────────────────────────────────────────────

  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Estado del drag actual sobre el overlay
  const dragging = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Rect visual (en píxeles del DOM, relativo al overlay)
  const [selectionPx, setSelectionPx] = useState<CropRect>(null);
  // true solo cuando el rectángulo actual coincide con el último "Confirmar".
  // Se pone a false en cuanto el usuario empieza a redibujar.
  const [selectionConfirmed, setSelectionConfirmed] = useState(false);

  // Convierte coords de pantalla relativas al overlay a fracción 0-1
  // (independiente del tamaño de display del overlay).
  function toPct(el: HTMLDivElement, clientX: number, clientY: number) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!overlayRef.current) return;
    e.preventDefault();
    dragging.current = true;
    // El usuario empieza un nuevo arrastre → la selección deja de estar confirmada
    setSelectionConfirmed(false);
    const { x, y } = toPct(overlayRef.current, e.clientX, e.clientY);
    dragStart.current = { x, y };
    setSelectionPx({ x, y, w: 0, h: 0 });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging.current || !dragStart.current || !overlayRef.current) return;
    const { x, y } = toPct(overlayRef.current, e.clientX, e.clientY);
    const sx = Math.min(dragStart.current.x, x);
    const sy = Math.min(dragStart.current.y, y);
    setSelectionPx({
      x: sx, y: sy,
      w: Math.abs(x - dragStart.current.x),
      h: Math.abs(y - dragStart.current.y),
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Touch equivalents para móvil/tablet
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!overlayRef.current) return;
    const t = e.touches[0];
    dragging.current = true;
    setSelectionConfirmed(false);
    const { x, y } = toPct(overlayRef.current, t.clientX, t.clientY);
    dragStart.current = { x, y };
    setSelectionPx({ x, y, w: 0, h: 0 });
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (!dragging.current || !dragStart.current || !overlayRef.current) return;
    const t = e.touches[0];
    const { x, y } = toPct(overlayRef.current, t.clientX, t.clientY);
    const sx = Math.min(dragStart.current.x, x);
    const sy = Math.min(dragStart.current.y, y);
    setSelectionPx({
      x: sx, y: sy,
      w: Math.abs(x - dragStart.current.x),
      h: Math.abs(y - dragStart.current.y),
    });
  }, []);

  const handleTouchEnd = useCallback(() => {
    dragging.current = false;
  }, []);

  // Confirma el recorte actual: extrae la región seleccionada a canvas
  // y guarda el data URL en el ticket correspondiente.
  function confirmCrop() {
    if (!selectionPx || selectionPx.w < 0.02 || selectionPx.h < 0.02) {
      setError("Selecciona un área más grande para el recorte.");
      return;
    }
    const img = imgRef.current;
    if (!img) return;

    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;

    const sx = Math.round(selectionPx.x * naturalW);
    const sy = Math.round(selectionPx.y * naturalH);
    const sw = Math.round(selectionPx.w * naturalW);
    const sh = Math.round(selectionPx.h * naturalH);

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    setTickets((prev) =>
      prev.map((t, i) => (i === currentIdx ? { ...t, crop: selectionPx } : t))
    );
    // Guardamos el dataUrl en un ref paralelo para no meter blobs en state
    dataUrls.current[currentIdx] = dataUrl;
    setError(null);

    // Avanzar al siguiente ticket automáticamente
    if (currentIdx < tickets.length - 1) {
      const nextIdx = currentIdx + 1;
      setCurrentIdx(nextIdx);
      const nextCrop = tickets[nextIdx]?.crop ?? null;
      setSelectionPx(nextCrop);
      // El ticket destino ya estaba confirmado si tiene dataUrl guardado
      setSelectionConfirmed(Boolean(dataUrls.current[nextIdx]));
    } else {
      // Último ticket: marcar la selección actual como confirmada
      setSelectionConfirmed(true);
    }
  }

  // Almacén de data URLs fuera del state (pueden ser grandes)
  const dataUrls = useRef<Record<number, string>>({});

  // ── Envío final ──────────────────────────────────────────────────────────

  function handleSubmit() {
    setError(null);
    const missing = tickets.findIndex((_, i) => !dataUrls.current[i]);
    if (missing !== -1) {
      setError(`Falta recortar el ticket "${tickets[missing].name}".`);
      return;
    }

    const splitTickets: SplitTicket[] = tickets.map((t, i) => ({
      name: t.name.trim() || `ticket${i + 1}`,
      dataUrl: dataUrls.current[i],
    }));

    startTransition(async () => {
      const result = await splitInvoice(invoiceId, splitTickets, bucket);
      if (result?.error) setError(result.error);
      // Si no hay error, splitInvoice hace redirect() — el componente
      // no llegará a este punto.
    });
  }

  // ── Paso 1: configuración ────────────────────────────────────────────────

  function updateCount(n: number) {
    const clamped = Math.max(2, Math.min(20, n));
    setCount(clamped);
    setTickets((prev) => {
      const next = [...prev];
      while (next.length < clamped) next.push({ name: `ticket${next.length + 1}`, crop: null });
      return next.slice(0, clamped);
    });
  }

  function updateName(idx: number, name: string) {
    setTickets((prev) => prev.map((t, i) => (i === idx ? { ...t, name } : t)));
  }

  function goToCrop() {
    if (tickets.some((t) => !t.name.trim())) {
      setError("Todos los tickets deben tener un nombre.");
      return;
    }
    setError(null);
    setCurrentIdx(0);
    setSelectionPx(null);
    setSelectionConfirmed(false);
    setStep("crop");
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const allCropped = tickets.every((_, i) => Boolean(dataUrls.current[i]));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl"
        style={{ maxHeight: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Scissors className="h-4.5 w-4.5 text-indigo-600" />
            <span className="text-[15px] font-semibold text-slate-800">
              {step === "configure" ? "Dividir en tickets" : `Recortar ticket ${currentIdx + 1} de ${tickets.length}`}
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === "configure" ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
              <p className="text-[13px] text-slate-500">
                Esta foto contiene varios tickets. Indica cuántos hay y ponles un nombre; después recortarás cada uno.
              </p>

              <div className="flex items-center gap-3">
                <label className="text-[13px] font-medium text-slate-700 w-28 flex-shrink-0">
                  Nº de tickets
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

              <div className="space-y-2">
                <p className="text-[12px] font-medium text-slate-500 uppercase tracking-wide">
                  Nombres de las nuevas facturas
                </p>
                {tickets.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-6 text-right text-[12px] text-slate-400">{i + 1}.</span>
                    <input
                      value={t.name}
                      onChange={(e) => updateName(i, e.target.value)}
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-indigo-300"
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

            <div className="flex-shrink-0 flex justify-end gap-2 border-t border-slate-100 px-5 py-4">
              <button
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={goToCrop}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-indigo-700"
              >
                Siguiente — recortar
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Selector de ticket en el paso de recorte */}
            <div className="flex-shrink-0 flex gap-1.5 overflow-x-auto border-b border-slate-100 px-5 py-2.5">
              {tickets.map((t, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setCurrentIdx(i);
                    setSelectionPx(tickets[i].crop);
                    // El ticket al que salto está confirmado si tiene dataUrl
                    setSelectionConfirmed(Boolean(dataUrls.current[i]));
                  }}
                  className={`flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition flex-shrink-0 ${
                    i === currentIdx
                      ? "bg-indigo-600 text-white"
                      : dataUrls.current[i]
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {dataUrls.current[i] && i !== currentIdx && <Check className="h-3 w-3" />}
                  {t.name}
                </button>
              ))}
            </div>

            {/* Área de recorte */}
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden px-5 pt-3 pb-1">
              <p className="flex-shrink-0 text-[12px] text-slate-500 mb-2">
                Arrastra sobre la imagen para seleccionar la zona del{" "}
                <strong className="text-slate-700">{tickets[currentIdx]?.name}</strong>.
              </p>
              {/* Contenedor externo: centra la imagen */}
              <div className="relative flex flex-1 min-h-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 select-none">
                {blobLoading && (
                  <div className="flex flex-col items-center gap-2 text-slate-400">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-[12px]">Cargando imagen…</span>
                  </div>
                )}
                {/* Wrapper que tiene exactamente el tamaño renderizado de la imagen.
                    El overlay absolute inset-0 dentro de él cubre solo el área de
                    la imagen, no el espacio vacío alrededor (letterbox). */}
                <div
                  className="relative max-h-full max-w-full"
                  style={{ display: blobUrl ? "block" : "none", lineHeight: 0 }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={blobUrl ?? undefined}
                    alt="Factura original"
                    className="block max-h-full max-w-full object-contain rounded-xl"
                    draggable={false}
                  />
                  {/* Overlay de selección — mismo tamaño que la imagen */}
                  <div
                    ref={overlayRef}
                    className="absolute inset-0 cursor-crosshair"
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                  >
                    {/* Rectángulo de selección del ticket actual */}
                    {selectionPx && selectionPx.w > 0.005 && selectionPx.h > 0.005 && (
                      <div
                        className={`absolute pointer-events-none ${
                          selectionConfirmed
                            ? "border border-green-400 bg-green-300/10"
                            : "border-2 border-indigo-500 bg-indigo-400/10"
                        }`}
                        style={{
                          left:   `${selectionPx.x * 100}%`,
                          top:    `${selectionPx.y * 100}%`,
                          width:  `${selectionPx.w * 100}%`,
                          height: `${selectionPx.h * 100}%`,
                        }}
                      >
                        {selectionConfirmed && (
                          <span className="absolute -top-5 left-0 rounded bg-green-600 px-1 py-0.5 text-[10px] font-medium text-white whitespace-nowrap">
                            {tickets[currentIdx]?.name}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Recortes confirmados de los demás tickets */}
                    {tickets.map((t, i) => {
                      if (i === currentIdx || !t.crop || !dataUrls.current[i]) return null;
                      return (
                        <div
                          key={i}
                          className="absolute border border-green-400 bg-green-300/10 pointer-events-none"
                          style={{
                            left:   `${t.crop.x * 100}%`,
                            top:    `${t.crop.y * 100}%`,
                            width:  `${t.crop.w * 100}%`,
                            height: `${t.crop.h * 100}%`,
                          }}
                        >
                          <span className="absolute -top-5 left-0 rounded bg-green-600 px-1 py-0.5 text-[10px] font-medium text-white whitespace-nowrap">
                            {t.name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {error && (
              <div className="flex-shrink-0 mx-5 mt-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex-shrink-0 flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-4">
              <button
                onClick={() => { setStep("configure"); setError(null); }}
                className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-600 hover:bg-slate-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Volver
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={confirmCrop}
                  disabled={!selectionPx || selectionPx.w < 0.02}
                  className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-[13px] font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-40"
                >
                  <Crop className="h-3.5 w-3.5" />
                  Confirmar recorte
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={!allCropped || isPending}
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
          </>
        )}
      </div>
    </div>
  );
}
