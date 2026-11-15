import type { Instrumentation } from "next";

/**
 * Errores del servidor (render, route handlers, server actions, proxy): una
 * linea JSON en el log y, con ALERT_WEBHOOK_URL, un aviso (F-034). Ver
 * src/lib/errorReporting.ts. Ademas, un ticket automatico en Soporte para el
 * equipo (src/lib/autoTickets.ts), que suma las repeticiones del mismo fallo.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { reportRequestError } = await import("@/lib/errorReporting");
  // Solo se espera a la linea del log; el aviso por webhook sigue solo.
  await reportRequestError(error, request, context);
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordServerErrorTicket } = await import("@/lib/autoTickets");
  // No lanza y espera como mucho unos segundos (con la BD caida no hay donde apuntarlo).
  await recordServerErrorTicket(error, request, context);
};

/**
 * Al parar el contenedor (SIGTERM), la cola del OCR deja de arrancar
 * analisis: lo que espera sigue en UPLOADED y lo relanza retry-stuck.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { stopStartingOcrOnShutdown } = await import("@/lib/ocrQueue");
  stopStartingOcrOnShutdown();
}
