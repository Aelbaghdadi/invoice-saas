"use client";

import { useEffect } from "react";

/**
 * Atajos de teclado globales para la pantalla de revision.
 *
 * Filosofia:
 *  - Ignoramos la tecla si el usuario esta escribiendo en un input/textarea
 *    con contenido distinto de vacio, EXCEPTO para las combinaciones con
 *    Ctrl/Cmd (que tienen prioridad siempre) y para Enter sobre un input
 *    normal (validacion rapida).
 *  - "?" abre/cierra el overlay de ayuda.
 *  - Las teclas individuales (R, D) exigen que el foco NO este en input.
 *
 * Orden de precedencia del Enter:
 *  - En textarea -> comportamiento nativo (salto de linea).
 *  - Con Ctrl/Cmd en cualquier sitio -> validar.
 *  - Sin modificadores en input/select/body -> validar.
 *
 * El caller pasa los handlers que quiere exponer; los que no pasa quedan
 * inactivos (no se asigna su atajo).
 */
export type ReviewShortcutHandlers = {
  onValidate?: () => void;
  onReject?: () => void;
  onMarkDuplicate?: () => void;
  onSave?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onToggleHelp?: () => void;
  /** Si devuelve true, el hook entiende que hay un modal abierto y no
   *  dispara los atajos (deja que el modal se maneje su teclado). */
  isBlocked?: () => boolean;
};

function isTypingInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return false;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // checkbox/radio/button no cuentan como typing
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  }
  return el.isContentEditable === true;
}

export function useReviewShortcuts(h: ReviewShortcutHandlers) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignorar repeticiones (cuando mantienes pulsada la tecla)
      if (e.repeat) return;
      if (h.isBlocked?.()) return;

      const isMod = e.ctrlKey || e.metaKey;
      const inInput = isTypingInput(e.target);
      const inTextarea = (e.target as HTMLElement)?.tagName === "TEXTAREA";

      // Ayuda: "?"
      if (e.key === "?" && !inInput) {
        e.preventDefault();
        h.onToggleHelp?.();
        return;
      }

      // Enter: validar (con Cmd/Ctrl siempre; sin modificador solo si no
      // estamos en textarea, y si el target no es un boton/link).
      if (e.key === "Enter" && h.onValidate) {
        if (isMod || !inTextarea) {
          // No interceptar si el foco esta en un boton (el Enter nativo lo
          // activa) o en un Link.
          const tag = (e.target as HTMLElement)?.tagName;
          if (tag === "BUTTON" || tag === "A") return;
          e.preventDefault();
          h.onValidate();
          return;
        }
      }

      // Ctrl/Cmd+S: guardar borrador
      if (isMod && (e.key === "s" || e.key === "S") && h.onSave) {
        e.preventDefault();
        h.onSave();
        return;
      }

      // R: rechazar (solo fuera de input)
      if ((e.key === "r" || e.key === "R") && !isMod && !inInput && h.onReject) {
        e.preventDefault();
        h.onReject();
        return;
      }

      // D: marcar duplicado (solo fuera de input)
      if ((e.key === "d" || e.key === "D") && !isMod && !inInput && h.onMarkDuplicate) {
        e.preventDefault();
        h.onMarkDuplicate();
        return;
      }

      // Alt+Left/Right: navegacion prev/next sin validar
      if (e.altKey && e.key === "ArrowRight" && h.onNext) {
        e.preventDefault();
        h.onNext();
        return;
      }
      if (e.altKey && e.key === "ArrowLeft" && h.onPrev) {
        e.preventDefault();
        h.onPrev();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [h]);
}
