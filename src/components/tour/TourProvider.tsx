"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { ArrowLeft, ArrowRight, Loader2, X } from "lucide-react";
import {
  hasTour,
  holeRect,
  isOnStepPage,
  placePopover,
  tourSelectors,
  tourStepsFor,
  type TourRect,
} from "@/lib/tourSteps";

type TourContextValue = { available: boolean; active: boolean; start: () => void };

const TourContext = createContext<TourContextValue>({ available: false, active: false, start: () => {} });

/** Para el botón «Recorrido» de la barra de arriba. */
export function useTour(): TourContextValue {
  return useContext(TourContext);
}

// El paso en curso sobrevive a una recarga de la página (no a cerrar la pestaña).
const STORAGE_KEY = "faktury.recorrido";
// Lo que se espera a que aparezca el bloque (datos que llegan tarde, el visor
// del PDF que se carga aparte) y a que termine una navegación.
const TARGET_WAIT_MS = 4000;
const NAV_WAIT_MS = 12000;
const POPOVER_WIDTH = 380;
const NARROW = 640;

type Phase = "navigating" | "finding" | "shown";
type Layout = { hole: TourRect | null; top: number; left: number; width: number; docked: boolean };

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findTarget(selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = Array.from(document.querySelectorAll(selector)).find(isVisible);
    if (el) return el;
  }
  return null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function sameLayout(a: Layout | null, b: Layout): boolean {
  if (!a) return false;
  const h = (x: TourRect | null) => (x ? `${x.top},${x.left},${x.width},${x.height}` : "-");
  return a.top === b.top && a.left === b.left && a.width === b.width && a.docked === b.docked && h(a.hole) === h(b.hole);
}

export function TourProvider({ role, children }: { role: Role; children: React.ReactNode }) {
  const steps = useMemo(() => tourStepsFor(role), [role]);
  const available = hasTour(role) && steps.length > 0;
  const router = useRouter();
  const pathname = usePathname();

  const [index, setIndex] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>("shown");
  const [offPage, setOffPage] = useState(false);
  const [target, setTarget] = useState<Element | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [mounted, setMounted] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  // La navegación lanzada para un paso: desde qué ruta, para saber cuándo ha
  // terminado (o si una redirección nos ha dejado en otra pantalla).
  const navRef = useRef<{ index: number; from: string } | null>(null);
  // El último paso atendido: si la ruta cambia sin cambiar de paso ni haber
  // navegado el recorrido, es que la persona se ha ido a otra pantalla.
  const handledRef = useRef<number | null>(null);

  const active = index !== null;
  const step = index !== null ? steps[index] : null;

  const stop = useCallback(() => {
    navRef.current = null;
    handledRef.current = null;
    setIndex(null);
    setTarget(null);
    setLayout(null);
    setOffPage(false);
  }, []);

  const start = useCallback(() => {
    if (!available) return;
    navRef.current = null;
    handledRef.current = null;
    setOffPage(false);
    setTarget(null);
    setIndex(0);
  }, [available]);

  const go = useCallback(
    (next: number) => {
      if (next < 0) return;
      if (next >= steps.length) {
        stop();
        return;
      }
      // El bloque del paso anterior se queda resaltado hasta que aparece el
      // nuevo: sin parpadeo entre pasos de la misma pantalla.
      setOffPage(false);
      setIndex(next);
    },
    [steps.length, stop],
  );

  // Arranque: el paso guardado (una recarga a mitad, solo si se sigue en su
  // pantalla: si no, la persona se ha ido y no se la trae de vuelta) o
  // «?recorrido=1».
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- el portal solo existe en el navegador
    setMounted(true);
    if (!available) return;
    let saved: number | null = null;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as { index?: unknown }) : null;
      if (
        parsed &&
        typeof parsed.index === "number" &&
        parsed.index >= 0 &&
        parsed.index < steps.length &&
        isOnStepPage(steps[parsed.index], window.location.pathname)
      ) {
        saved = parsed.index;
      } else if (raw) {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* sin almacenamiento: se empieza de cero */
    }
    const fromUrl = new URLSearchParams(window.location.search).get("recorrido") === "1";
    if (saved !== null) setIndex(saved);
    else if (fromUrl) setIndex(0);
  }, [available, steps]);

  useEffect(() => {
    try {
      if (index === null) window.sessionStorage.removeItem(STORAGE_KEY);
      else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ index }));
    } catch {
      /* ignore */
    }
  }, [index]);

  // Llevar a la pantalla del paso y buscar su bloque.
  useEffect(() => {
    if (index === null) return;
    const current = steps[index];
    if (!current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const stepChanged = handledRef.current !== index;
    handledRef.current = index;

    if (isOnStepPage(current, pathname)) {
      navRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza el recorrido con la ruta (sistema externo)
      setOffPage(false);
      const selectors = tourSelectors(current);
      if (selectors.length === 0) {
        setTarget(null);
        setPhase("shown");
        return;
      }
      setPhase("finding");
      const started = Date.now();
      const tick = () => {
        if (cancelled) return;
        const el = findTarget(selectors);
        if (el) {
          const tall = el.getBoundingClientRect().height > window.innerHeight * 0.75;
          el.scrollIntoView({ block: tall ? "start" : "center", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
          setTarget(el);
          setPhase("shown");
          return;
        }
        if (Date.now() - started > TARGET_WAIT_MS) {
          setTarget(null);
          setPhase("shown");
          return;
        }
        timer = setTimeout(tick, 120);
      };
      tick();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }

    const nav = navRef.current;
    if (nav && nav.index === index) {
      // Ya se navegó para este paso. Si la ruta ha cambiado y no es la del
      // paso, una redirección nos ha llevado a otra pantalla.
      if (pathname !== nav.from) {
        setOffPage(true);
        setTarget(null);
        setPhase("shown");
      }
      return;
    }
    if (!stepChanged) {
      // Mismo paso, otra pantalla y sin navegación del recorrido: la persona
      // se ha ido por su cuenta (atrás, un enlace de lo resaltado). Se cierra
      // en vez de llevarla de vuelta.
      stop();
      return;
    }
    navRef.current = { index, from: pathname };
    setPhase("navigating");
    setTarget(null);
    router.push(current.path);
    timer = setTimeout(() => {
      if (cancelled) return;
      setOffPage(true);
      setPhase("shown");
    }, NAV_WAIT_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [index, pathname, steps, router, stop]);

  // Seguir al bloque: el scroll, los datos que llegan y el tamaño de la ventana
  // lo mueven. Un bucle por fotograma es lo más sencillo y no pinta si nada cambia.
  useEffect(() => {
    if (index === null || phase !== "shown") return;
    const current = steps[index];
    let frame = 0;
    let el = target;
    const loop = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (el && !document.contains(el)) el = current ? findTarget(tourSelectors(current)) : null;
      const rect = el && !offPage ? el.getBoundingClientRect() : null;
      const hole = rect ? holeRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, { width: vw, height: vh }) : null;
      const docked = vw < NARROW;
      const width = Math.min(POPOVER_WIDTH, vw - 24);
      const popHeight = popRef.current?.offsetHeight ?? 220;
      const pos = placePopover(hole, { width, height: popHeight }, { width: vw, height: vh }, current?.placement);
      const next: Layout = {
        hole: hole && hole.width > 0 && hole.height > 0 ? { top: Math.round(hole.top), left: Math.round(hole.left), width: Math.round(hole.width), height: Math.round(hole.height) } : null,
        top: Math.round(pos.top),
        left: Math.round(pos.left),
        width: Math.round(width),
        docked,
      };
      setLayout((prev) => (sameLayout(prev, next) ? prev : next));
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [index, phase, target, offPage, steps]);

  // El foco al cuadro de cada paso (lector de pantalla y teclado).
  useEffect(() => {
    if (phase === "shown") popRef.current?.focus({ preventScroll: true });
  }, [phase, index]);

  // Teclado: flechas para avanzar o volver, Escape para salir. Se escucha en
  // captura y no se deja pasar nada más a la página: la revisión valida con
  // Intro y rechaza con R (useReviewShortcuts), y un Intro sobre «Siguiente»
  // validaría además la factura. Lo que se escribe en un campo sí pasa.
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const editable = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "Escape") {
        e.stopPropagation();
        stop();
        return;
      }
      if (editable) return;
      e.stopPropagation();
      if (phase !== "shown") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, phase, go, stop]);

  const finish = useCallback(
    (path: string) => {
      stop();
      router.push(path);
    },
    [router, stop],
  );

  const ctx = useMemo(() => ({ available, active, start }), [available, active, start]);

  let overlay: React.ReactNode = null;
  if (mounted && step && index !== null) {
    const total = steps.length;
    const isLast = index === total - 1;
    const hole = phase === "shown" ? layout?.hole ?? null : null;
    const body = offPage && step.fallbackBody ? step.fallbackBody : step.body;
    const veil = "fixed bg-slate-900/55";
    const popStyle: React.CSSProperties = layout?.docked
      ? { left: 12, right: 12, bottom: "max(12px, env(safe-area-inset-bottom, 0px))" }
      : { top: layout?.top ?? -9999, left: layout?.left ?? -9999, width: layout?.width ?? POPOVER_WIDTH };

    overlay = createPortal(
      <div className="fixed inset-0 z-[200]" data-tour-overlay>
        {/* Velo: cuatro piezas alrededor del hueco, para que lo resaltado se
            pueda tocar y lo demás no. */}
        {hole ? (
          <>
            <div className={veil} style={{ top: 0, left: 0, right: 0, height: hole.top }} />
            <div className={veil} style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
            <div className={veil} style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
            <div className={veil} style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
            <div
              aria-hidden
              className="pointer-events-none fixed rounded-xl ring-2 ring-blue-400 shadow-[0_0_0_6px_rgba(59,130,246,0.22)] motion-safe:transition-all motion-safe:duration-300"
              style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
            />
          </>
        ) : (
          <div className={`${veil} inset-0`} />
        )}

        {phase !== "shown" ? (
          <div className="fixed left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5 rounded-xl bg-white px-4 py-3 text-[13px] font-medium text-slate-700 shadow-xl">
            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            {phase === "navigating" ? `Abriendo «${step.chapter}»…` : "Un momento…"}
          </div>
        ) : (
          <div
            ref={popRef}
            role="dialog"
            aria-modal="false"
            aria-labelledby="recorrido-titulo"
            aria-describedby="recorrido-texto"
            tabIndex={-1}
            className="fixed rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl outline-none motion-safe:transition-[top,left] motion-safe:duration-300"
            style={popStyle}
          >
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">{step.chapter}</span>
              <span className="text-[11px] tabular-nums text-slate-400">
                {index + 1} de {total}
              </span>
              <button
                type="button"
                onClick={stop}
                aria-label="Salir del recorrido"
                className="-mr-2 ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <h2 id="recorrido-titulo" className="mt-1 text-[18px] font-semibold leading-snug tracking-tight text-slate-900 [text-wrap:balance]">
              {step.title}
            </h2>
            <p id="recorrido-texto" aria-live="polite" className="mt-2 text-[14px] leading-relaxed text-slate-600">
              {body}
            </p>
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
              <div className="h-full rounded-full bg-blue-600 motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${((index + 1) / total) * 100}%` }} />
            </div>
            <div className="mt-4 flex items-center gap-2">
              {index > 0 && (
                <button
                  type="button"
                  onClick={() => go(index - 1)}
                  aria-label="Anterior"
                  className="flex min-h-[42px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-200 px-3.5 text-[13px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {/* En el último paso no cabe con los otros dos botones. */}
                  {!step.finalAction && "Anterior"}
                </button>
              )}
              <span className="flex-1" />
              {step.finalAction ? (
                <>
                  <button
                    type="button"
                    onClick={stop}
                    className="flex min-h-[42px] items-center whitespace-nowrap rounded-xl px-3 text-[13px] font-semibold text-slate-500 hover:bg-slate-50"
                  >
                    Terminar
                  </button>
                  <button
                    type="button"
                    onClick={() => finish(step.finalAction!.path)}
                    className="flex min-h-[42px] items-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
                  >
                    {step.finalAction.label}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => go(index + 1)}
                  className="flex min-h-[42px] items-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
                >
                  {index === 0 ? "Empezar" : isLast ? "Terminar" : "Siguiente"}
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>,
      document.body,
    );
  }

  return (
    <TourContext.Provider value={ctx}>
      {children}
      {overlay}
    </TourContext.Provider>
  );
}
