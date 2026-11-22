"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Document, Page, pdfjs } from "react-pdf";
import {
  AlertTriangle, ChevronLeft, ChevronRight, Loader2, Maximize2, RefreshCw, Scissors, X,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { splitWholeTacoAction } from "@/app/dashboard/archivo/tandas/[id]/dividir/actions";
import { planTacoRanges } from "@/lib/tacoSplitPlan";
import { invoiceCountText, tacoMarksBar, tacoReviewItems, tacoSplitWarnings } from "@/lib/tacoSplitReview";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

type Props = {
  batchId: string;
  tacoNumber: number;
  clientName: string;
  /** «Octubre 2026 · Recibidas». */
  lotLabel: string;
  pageCount: number;
  pdfUrl: string;
};

const THUMB_WIDTH = 180;
/** Alto de reserva de una miniatura A4 mientras no se pinta. */
const THUMB_HEIGHT = Math.round(THUMB_WIDTH * 1.414);
const ZOOM_WIDTH = 700;
/** Con 500 páginas, cada canvas a la densidad de una pantalla retina pesa: las miniaturas, a 1,5 como mucho. */
const THUMB_PIXEL_RATIO = 1.5;

const storageKey = (batchId: string) => `taco-marcas-${batchId}`;

/** Las marcas guardadas de este taco (para no perderlas al recargar), o la 1. */
function readMarks(batchId: string, pageCount: number): number[] {
  try {
    const raw = window.localStorage.getItem(storageKey(batchId));
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      if (Array.isArray(saved)) {
        const pages = saved.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= pageCount);
        return [...new Set(pages)].sort((a, b) => a - b);
      }
    }
  } catch {
    // Sin localStorage (modo privado, bloqueado): se empieza de cero.
  }
  return [1];
}

function writeMarks(batchId: string, marks: number[] | null) {
  try {
    if (marks) window.localStorage.setItem(storageKey(batchId), JSON.stringify(marks));
    else window.localStorage.removeItem(storageKey(batchId));
  } catch {
    // Sin localStorage las marcas solo viven en la pestaña.
  }
}

const Thumb = memo(function Thumb({
  page,
  order,
  onToggle,
  onZoom,
}: {
  page: number;
  /** Nº de la factura que empieza aquí, o null si no hay marca. */
  order: number | null;
  onToggle: (page: number) => void;
  onZoom: (page: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // Solo se pintan las que están cerca de la vista: con 500 páginas, todas a
  // la vez se comen la memoria del navegador.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const marked = order != null;

  return (
    <div ref={box} className="relative flex flex-col items-center gap-1">
      <button
        type="button"
        aria-pressed={marked}
        aria-label={marked ? `Pág. ${page}: empieza la factura ${order}` : `Pág. ${page}`}
        onClick={() => onToggle(page)}
        className={`relative overflow-hidden rounded-lg border-2 bg-white shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
          marked ? "border-blue-600" : "border-slate-200 hover:border-slate-400"
        }`}
        style={{ width: THUMB_WIDTH + 4, minHeight: THUMB_HEIGHT + 4 }}
      >
        {near ? (
          <Page
            pageNumber={page}
            width={THUMB_WIDTH}
            devicePixelRatio={Math.min(THUMB_PIXEL_RATIO, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1)}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            loading={<div style={{ height: THUMB_HEIGHT }} className="flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-300" /></div>}
            error={<div style={{ height: THUMB_HEIGHT }} className="flex items-center justify-center px-3 text-[11px] text-slate-400">No se ha podido pintar esta página.</div>}
          />
        ) : (
          <div style={{ height: THUMB_HEIGHT }} />
        )}
        {marked && (
          <span className="absolute left-0 top-0 rounded-br-lg bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white">
            Factura {order} empieza aquí
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => onZoom(page)}
        aria-label={`Ampliar la pág. ${page}`}
        title="Ampliar"
        className="absolute right-1.5 top-1.5 rounded-md bg-white/90 p-1 text-slate-600 shadow ring-1 ring-slate-200 hover:bg-white hover:text-slate-900"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <span className={`text-[12px] ${marked ? "font-semibold text-blue-700" : "text-slate-500"}`}>Pág. {page}</span>
    </div>
  );
});

/**
 * «Marca dónde empieza cada factura» de un taco entero (5.8): las páginas del
 * PDF en miniatura, la vista ampliada con teclado y, antes de crear nada, la
 * revisión de los rangos con sus avisos. Las marcas se guardan en el navegador
 * hasta que se crean las facturas.
 */
export default function TacoSplitPicker({ batchId, tacoNumber, clientName, lotLabel, pageCount, pdfUrl }: Props) {
  const router = useRouter();
  const { success } = useToast();
  const [marks, setMarks] = useState<number[]>(() => readMarks(batchId, pageCount));
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [zoomPage, setZoomPage] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState(false);

  useEffect(() => {
    // Ya creadas, las marcas sobran (y el taco no se vuelve a dividir).
    if (!created) writeMarks(batchId, marks);
  }, [batchId, marks, created]);

  const orderOf = useMemo(() => new Map(marks.map((page, i) => [page, i + 1])), [marks]);
  const plan = useMemo(() => planTacoRanges(marks, pageCount), [marks, pageCount]);
  const { invoiceCount, error: marksError } = tacoMarksBar(marks, plan);

  const toggle = useCallback((page: number) => {
    setMarks((current) =>
      current.includes(page) ? current.filter((p) => p !== page) : [...current, page].sort((a, b) => a - b));
  }, []);
  const zoom = useCallback((page: number) => setZoomPage(page), []);

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await splitWholeTacoAction({ batchId, startPages: marks });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setCreated(true);
      writeMarks(batchId, null);
      success(result.invoiceCount === 1
        ? "Se ha creado 1 factura y se está analizando."
        : `Se han creado ${result.invoiceCount} facturas y se están analizando.`);
      router.push(`/dashboard/archivo/tandas/${batchId}`);
    });
  };

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);

  return (
    <div>
      <Document
        key={attempt}
        file={pdfUrl}
        onLoadSuccess={() => { setLoaded(true); setLoadFailed(false); }}
        onLoadError={() => setLoadFailed(true)}
        onSourceError={() => setLoadFailed(true)}
        loading={
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Cargando el PDF del taco…
          </div>
        }
        error={null}
        noData={null}
      >
        {loaded && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] justify-items-center gap-x-3 gap-y-5 pb-6">
            {pages.map((page) => (
              <Thumb key={page} page={page} order={orderOf.get(page) ?? null} onToggle={toggle} onZoom={zoom} />
            ))}
          </div>
        )}

        {zoomPage != null && (
          <ZoomPanel
            page={zoomPage}
            pageCount={pageCount}
            order={orderOf.get(zoomPage) ?? null}
            onToggle={toggle}
            onGo={setZoomPage}
            onClose={() => setZoomPage(null)}
          />
        )}
      </Document>

      {loadFailed && (
        <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-8 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
          <p className="text-[13px] font-medium text-amber-900">No se ha podido cargar el PDF del taco.</p>
          <p className="text-[12px] text-amber-800">Puede ser un fallo de conexión. Si al reintentar sigue igual, recarga la página.</p>
          <button
            type="button"
            onClick={() => { setLoadFailed(false); setAttempt((a) => a + 1); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-900 hover:bg-amber-100"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reintentar
          </button>
        </div>
      )}

      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-t-xl sm:border sm:shadow-lg">
        <div className="min-w-0">
          <p className="text-[13px] text-slate-700">
            <span className="font-semibold">{invoiceCountText(invoiceCount)}</span> · {pageCount} {pageCount === 1 ? "página" : "páginas"}
          </p>
          {marksError && loaded && <p role="alert" className="text-[12px] text-amber-700">{marksError}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMarks([])}
            disabled={marks.length === 0 || pending}
            className="rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Quitar todas las marcas
          </button>
          <button
            type="button"
            onClick={() => { setError(null); setReviewing(true); }}
            disabled={!plan.ok || !loaded || pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Scissors className="h-4 w-4" />
            {invoiceCount === 1 ? "Revisar la factura" : `Revisar las ${invoiceCount} facturas`}
          </button>
        </div>
      </div>

      {reviewing && plan.ok && (
        <ReviewDialog
          tacoNumber={tacoNumber}
          clientName={clientName}
          lotLabel={lotLabel}
          ranges={plan.ranges}
          pending={pending || created}
          error={error}
          onBack={() => { if (!pending) setReviewing(false); }}
          onCreate={create}
        />
      )}
    </div>
  );
}

function ZoomPanel({
  page,
  pageCount,
  order,
  onToggle,
  onGo,
  onClose,
}: {
  page: number;
  pageCount: number;
  order: number | null;
  onToggle: (page: number) => void;
  onGo: (page: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [width] = useState(() => Math.max(240, Math.min(ZOOM_WIDTH, (typeof window === "undefined" ? ZOOM_WIDTH : window.innerWidth) - 48)));
  useEffect(() => panel.current?.focus(), []);
  const marked = order != null;
  const previous = () => onGo(Math.max(1, page - 1));
  const next = () => onGo(Math.min(pageCount, page + 1));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Pág. ${page} del PDF`}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); previous(); }
          else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
          else if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); onToggle(page); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        className="flex max-h-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl focus:outline-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <p className="text-[13px] font-semibold text-slate-800">
            Pág. {page} de {pageCount}
            {marked && <span className="ml-2 rounded bg-blue-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Factura {order} empieza aquí</span>}
          </p>
          <p className="text-[11px] text-slate-400">← → cambian de página · Espacio marca</p>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-slate-100 p-3">
          <Page
            key={page}
            pageNumber={page}
            width={width}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            className="mx-auto shadow"
            loading={<div style={{ width, height: Math.round(width * 1.414) }} className="flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-300" /></div>}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5">
          <div className="flex gap-2">
            <button type="button" onClick={previous} disabled={page <= 1} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              <ChevronLeft className="h-4 w-4" /> Anterior
            </button>
            <button type="button" onClick={next} disabled={page >= pageCount} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              Siguiente <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onToggle(page)}
              className={marked
                ? "rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
                : "rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-blue-700"}
            >
              {marked ? "Quitar la marca" : "Empieza aquí una factura"}
            </button>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-700 hover:bg-slate-50">
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewDialog({
  tacoNumber,
  clientName,
  lotLabel,
  ranges,
  pending,
  error,
  onBack,
  onCreate,
}: {
  tacoNumber: number;
  clientName: string;
  lotLabel: string;
  ranges: { start: number; end: number }[];
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: () => void;
}) {
  const items = useMemo(() => tacoReviewItems(ranges), [ranges]);
  const warnings = useMemo(() => tacoSplitWarnings(ranges), [ranges]);
  const dialog = useRef<HTMLDivElement>(null);
  // El foco en el diálogo y no en «Crear las facturas»: un Intro de más no las crea.
  useEffect(() => dialog.current?.focus(), []);
  const one = ranges.length === 1;
  const created = one
    ? `Se creará 1 factura de ${clientName} en ${lotLabel} y se analizará.`
    : `Se crearán ${invoiceCountText(ranges.length)} de ${clientName} en ${lotLabel} y se analizarán.`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="revision-taco-titulo"
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onBack(); } }}
        className="animate-scale-in flex max-h-full w-full max-w-xl flex-col rounded-2xl bg-white shadow-2xl focus:outline-none"
      >
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 id="revision-taco-titulo" className="text-[15px] font-semibold text-slate-800">
            Taco {tacoNumber}: {one ? "revisa la factura" : `revisa las ${ranges.length} facturas`}
          </h3>
          <p className="mt-1 text-[13px] text-slate-600">
            {created} Las marcas no se pueden cambiar después: si una factura sale con dos, divídela en la revisión; si
            sale partida en dos, habrá que rechazar las dos mitades y subirla entera aparte.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {warnings.length > 0 && (
            <ul className="mb-3 space-y-1.5">
              {warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
                  {warning}
                </li>
              ))}
            </ul>
          )}
          <ol className="divide-y divide-slate-100 text-[13px]">
            {items.map((item) => (
              <li key={`${item.kind}-${item.range.start}`} className={`py-1.5 ${item.kind === "skipped" ? "text-slate-400" : "text-slate-700"}`}>
                {item.text}
              </li>
            ))}
          </ol>
        </div>
        {error && (
          <p role="alert" className="mx-5 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onBack}
            disabled={pending}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Volver a las marcas
          </button>
          <button
            type="button"
            onClick={onCreate}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {pending ? "Creando las facturas…" : "Crear las facturas"}
          </button>
        </div>
      </div>
    </div>
  );
}
