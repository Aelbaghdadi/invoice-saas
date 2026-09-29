"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";

type Toast = {
  id: string;
  type: ToastType;
  message: string;
};

type ToastContextType = {
  toast: (type: ToastType, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
};

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const STYLES = {
  success: "bg-emerald-50 border-emerald-200 text-emerald-800",
  error: "bg-red-50 border-red-200 text-red-800",
  warning: "bg-amber-50 border-amber-200 text-amber-800",
  info: "bg-blue-50 border-blue-200 text-blue-800",
};

const ICON_STYLES = {
  success: "text-emerald-500",
  error: "text-red-500",
  warning: "text-amber-500",
  info: "text-blue-500",
};

// Los errores y avisos suelen pedir hacer algo ("Avisa al administrador"):
// con 4 s se iban antes de poder leerlos.
const DURATION_MS: Record<ToastType, number> = {
  success: 3000,
  info: 4000,
  warning: 8000,
  error: 10000,
};

/** Un aviso con su propio temporizador, que se para mientras el raton o el
 *  foco estan encima para que dé tiempo a leerlo. */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const remainingMs = useRef(DURATION_MS[toast.type]);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remainingMs.current);
    return () => {
      clearTimeout(timer);
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt));
    };
  }, [paused, toast.id, onDismiss]);

  const Icon = ICONS[toast.type];
  return (
    <div
      className={`animate-fade-in-up pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-xl border px-4 py-3 shadow-lg sm:w-auto sm:min-w-[280px] ${STYLES[toast.type]}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className={`h-5 w-5 flex-shrink-0 ${ICON_STYLES[toast.type]}`} aria-hidden />
      <p className="flex-1 text-[13px] font-medium">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Cerrar aviso"
        className="flex-shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Un aviso identico al que ya se ve no se repite: pulsar Enter varias
  // veces con el importe descuadrado apilaba el mismo error de 10 s.
  const addToast = useCallback((type: ToastType, message: string) => {
    setToasts((prev) =>
      prev.some((t) => t.type === type && t.message === message)
        ? prev
        : [...prev, { id: crypto.randomUUID(), type, message }],
    );
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value: ToastContextType = {
    toast: addToast,
    success: (msg) => addToast("success", msg),
    error: (msg) => addToast("error", msg),
    warning: (msg) => addToast("warning", msg),
    info: (msg) => addToast("info", msg),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Centrados sobre la barra superior (h-14), cuyo centro no tiene nada
          clicable: abajo tapaban las barras de acción (Validar) y arriba a la
          derecha las flechas "<" ">" y "Siguiente pendiente" de la revisión.
          El contenedor ocupa todo el ancho y no recoge clics; solo cada aviso.
          En móvil, px-12 deja libres la hamburguesa y el avatar. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-1.5 z-[100] flex flex-col items-center gap-2 px-12 sm:px-4"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
