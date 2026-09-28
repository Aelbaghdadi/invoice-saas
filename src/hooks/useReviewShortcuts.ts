"use client";

import { useEffect } from "react";
import { altArrowAction } from "@/lib/reviewKeys";

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
 *  - Con Ctrl/Cmd en cualquier sitio -> validar.
 *  - Sin modificadores SOLO si el foco esta fuera de input/textarea/select
 *    (en el body): asi un Enter accidental mientras editas no te cambia
 *    de factura. Caso reportado: el gestor teclea un importe, pulsa
 *    Enter por instinto y la factura se valida sin querer.
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
  // Un desplegable ES un campo: con el foco en "Tipo", la R es para saltar a
  // "Recibida", no para abrir el rechazo, y Enter no puede validar la
  // factura. Antes devolvia false y pasaba justo eso (en produccion).
  if (tag === "SELECT") return true;
  // El desplegable propio (components/ui/Select) y su lista abierta, igual.
  if (el.getAttribute("role") === "combobox" || el.closest("[role=listbox]")) return true;
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
      const inInput = isTypingInput(e.target);
      // Alt+←/→ antes que nada: en Windows/Linux es «Atras» del navegador,
      // asi que se intercepta siempre (tambien mantenida o con un dialogo
      // abierto), aunque solo navegue sin repeticion y sin dialogo.
      const arrow = altArrowAction(e, { inInput, isMac: /Mac|iPhone|iPad/.test(navigator.platform) });
      if (arrow) {
        e.preventDefault();
        if (e.repeat || h.isBlocked?.()) return;
        if (arrow === "next") h.onNext?.();
        if (arrow === "prev") h.onPrev?.();
        return;
      }

      // Ignorar repeticiones (cuando mantienes pulsada la tecla)
      if (e.repeat) return;
      if (h.isBlocked?.()) return;

      const isMod = e.ctrlKey || e.metaKey;

      // Ayuda: "?"
      if (e.key === "?" && !inInput) {
        e.preventDefault();
        h.onToggleHelp?.();
        return;
      }

      // Enter: validar SOLO si:
      //  - Es Ctrl/Cmd+Enter (atajo explicito), o
      //  - No hay foco en ningun input/textarea/select.
      // Antes bastaba con Enter en cualquier input → si el gestor
      // tecleaba y pulsaba Enter por reflejo, se cambiaba de factura
      // sin haberla terminado de revisar. Ahora hace falta intencion.
      if (e.key === "Enter" && h.onValidate) {
        // Ctrl/Cmd+Enter valida SIEMPRE, este el foco donde este: es lo que
        // dice la ayuda. Antes, con el foco en un boton, se salia antes de
        // mirar el Ctrl y no pasaba nada.
        if (isMod) {
          e.preventDefault();
          h.onValidate();
          return;
        }
        const tag = (e.target as HTMLElement)?.tagName;
        // No interceptar Enter sobre boton/link (el navegador los activa).
        if (tag === "BUTTON" || tag === "A") return;
        if (!inInput) {
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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [h]);
}
