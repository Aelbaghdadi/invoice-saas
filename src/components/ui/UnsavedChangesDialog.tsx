"use client";

import { useCallback, useRef, useState } from "react";

export type UnsavedChoice = "save" | "discard" | "cancel";

/**
 * «Tienes cambios sin guardar» con tres salidas (F-047): Guardar, Descartar
 * o Cancelar. El aspecto es el de ConfirmDialog.
 *
 *   const { ask, dialog } = useUnsavedChangesDialog();
 *   const choice = await ask();
 */
export function useUnsavedChangesDialog() {
  const [open, setOpen] = useState(false);
  const resolver = useRef<((choice: UnsavedChoice) => void) | null>(null);

  const ask = useCallback(() => {
    resolver.current?.("cancel");
    setOpen(true);
    return new Promise<UnsavedChoice>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((choice: UnsavedChoice) => {
    resolver.current?.(choice);
    resolver.current = null;
    setOpen(false);
  }, []);

  const dialog = open ? <UnsavedChangesDialog onChoose={close} /> : null;
  return { ask, dialog };
}

function UnsavedChangesDialog({ onChoose }: { onChoose: (choice: UnsavedChoice) => void }) {
  const downOnBackdrop = useRef(false);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onChoose("cancel"); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-message"
        className="animate-scale-in w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onChoose("cancel");
          }
          // El Enter o el Alt+flecha mantenidos que abrieron el dialogo no
          // eligen nada.
          if (e.repeat) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <h3 id="unsaved-title" className="text-[15px] font-semibold text-slate-800">
          Tienes cambios sin guardar
        </h3>
        <p id="unsaved-message" className="mt-1.5 text-[13px] text-slate-500">
          Si sales ahora, se pierden. ¿Quieres guardarlos antes?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onChoose("cancel")}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onChoose("discard")}
            className="rounded-lg border border-red-200 px-4 py-2 text-[13px] font-medium text-red-600 hover:bg-red-50"
          >
            Descartar
          </button>
          {/* El foco empieza en Guardar: un Enter por inercia no pierde nada. */}
          <button
            type="button"
            autoFocus
            onClick={() => onChoose("save")}
            className="rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
