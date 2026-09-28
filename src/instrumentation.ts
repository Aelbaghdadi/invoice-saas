import type { Instrumentation } from "next";

/**
 * Errores del servidor (render, route handlers, server actions, proxy): una
 * linea JSON en el log y, con ALERT_WEBHOOK_URL, un aviso (F-034). Ver
 * src/lib/errorReporting.ts.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { reportRequestError } = await import("@/lib/errorReporting");
  await reportRequestError(error, request, context);
};
