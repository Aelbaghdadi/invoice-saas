"use client";

import { useState } from "react";
import { AlertCircle, Copy, Check } from "lucide-react";
import { type AppError } from "@/lib/errorCodes";

type Props = {
  error: AppError | string;
  /** Variante visual: "inline" usa colores rojos suaves para meterlo
   *  dentro de un form; "banner" más prominente para alertas globales. */
  variant?: "inline" | "banner";
};

/**
 * Muestra un error con código copiable para soporte.
 *
 * - Si recibe un AppError ({code, message, details}): renderiza el
 *   mensaje amable + un chip con el código + boton "copiar detalles"
 *   que copia al portapapeles la info técnica (código, mensaje, detalle,
 *   timestamp, URL).
 * - Si recibe un string: lo muestra tal cual (compatibilidad con los
 *   errores legacy que aún no tienen código).
 */
export function ErrorBox({ error, variant = "inline" }: Props) {
  const [copied, setCopied] = useState(false);

  const isAppError = typeof error !== "string";
  const message = isAppError ? error.message : error;

  const handleCopy = async () => {
    if (!isAppError) return;
    const payload = [
      `Código: ${error.code}`,
      `Mensaje: ${error.message}`,
      error.details ? `Detalles: ${error.details}` : null,
      `Hora: ${new Date().toISOString()}`,
      typeof window !== "undefined" ? `URL: ${window.location.href}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard puede fallar en http sin permiso — fallar silencioso */
    }
  };

  const containerClass =
    variant === "banner"
      ? "rounded-xl border border-red-200 bg-red-50 px-4 py-3"
      : "rounded-lg bg-red-50 px-3 py-2";

  return (
    <div className={`${containerClass} text-red-700`}>
      <div className="flex items-start gap-2.5">
        <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium">{message}</p>
          {isAppError && (
            <div className="mt-1.5 flex items-center gap-2 text-[11px]">
              <code className="rounded bg-red-100 px-1.5 py-0.5 font-mono font-semibold text-red-700">
                {error.code}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 rounded text-red-600 hover:text-red-800 hover:underline"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" />
                    Copiado
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copiar detalles para soporte
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
