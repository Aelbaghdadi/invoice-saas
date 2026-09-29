"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  /** Texto del boton que confirma: el verbo de la accion ("Eliminar"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" para lo que borra o no se puede deshacer. */
  tone?: "danger" | "primary";
};

/**
 * Confirmacion con el aspecto de la app. Sustituye al confirm() del
 * navegador, que sale como un cuadro gris "localhost dice…" y no se parece
 * en nada al resto.
 *
 * Uso, igual de corto que el confirm() de siempre:
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title: "¿Eliminar…?", tone: "danger" }))) return;
 *   ...
 *   return <>{dialog}…</>;
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    // Si quedaba otra abierta, se da por cancelada.
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const dialog = opts ? (
    <ConfirmDialog
      {...opts}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { confirm, dialog };
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Aceptar",
  cancelLabel = "Cancelar",
  tone = "primary",
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  // Se cierra pinchando fuera solo si el clic empezo fuera: al arrastrar
  // desde dentro y soltar en el fondo no tiene que cerrarse.
  const downOnBackdrop = useRef(false);
  const danger = tone === "danger";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="animate-scale-in w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h3 id="confirm-title" className="flex items-center gap-2 text-[15px] font-semibold text-slate-800">
          {danger && <AlertTriangle className="h-5 w-5 flex-shrink-0 text-red-500" />}
          {title}
        </h3>
        {message && <div className="mt-1.5 text-[13px] text-slate-500">{message}</div>}
        <div className="mt-5 flex justify-end gap-2">
          {/* En lo peligroso el foco empieza en Cancelar: un Enter por
              inercia no borra nada. */}
          <button
            type="button"
            autoFocus={danger}
            onClick={onCancel}
            className="rounded-lg border border-slate-200 px-4 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus={!danger}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-[13px] font-semibold text-white ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
