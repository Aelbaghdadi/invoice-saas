import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * Parametros de /api/export (vista previa por GET, descarga por POST).
 *
 * Cliente y periodo son obligatorios (F-071): antes eran opcionales y una
 * llamada sin parametros exportaba todo lo pendiente de la asesoria.
 */
const exportRequestSchema = z.object({
  clientId: z.string().trim().min(1),
  periodType: z.enum(["MONTHLY", "QUARTERLY"]),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  type: z.enum(["ALL", "PURCHASE", "SALE"]).default("ALL"),
  format: z.enum(["a3excel"]).default("a3excel"),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

const FIELD_LABELS: Record<string, string> = {
  clientId: "cliente",
  periodType: "tipo de periodo",
  month: "mes",
  year: "año",
  type: "tipo de factura",
  format: "formato",
};

// El trimestre se pide por su primer mes, como lo manda la pantalla.
const QUARTER_START_MONTHS = [1, 4, 7, 10];

export function parseExportRequest(
  input: Record<string, unknown>,
): { ok: true; request: ExportRequest } | { ok: false; error: string } {
  const parsed = exportRequestSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => FIELD_LABELS[String(i.path[0])] ?? String(i.path[0])))];
    return { ok: false, error: `Falta o no es válido: ${fields.join(", ")}.` };
  }
  const request = parsed.data;
  if (request.periodType === "QUARTERLY" && !QUARTER_START_MONTHS.includes(request.month)) {
    return { ok: false, error: "El trimestre se indica con su primer mes (1, 4, 7 o 10)." };
  }
  return { ok: true, request };
}

/**
 * Facturas pendientes de exportar para esa peticion, siempre dentro de la
 * asesoria. exportBatchId: null porque exportar no cambia el estado (sigue
 * VALIDATED): sin el filtro, cada exportacion repetia las ya exportadas.
 */
export function exportInvoiceWhere(request: ExportRequest, firmId: string): Prisma.InvoiceWhereInput {
  return {
    status: "VALIDATED",
    exportBatchId: null,
    client: { advisoryFirmId: firmId },
    clientId: request.clientId,
    periodYear: request.year,
    // Trimestral: del primer mes del trimestre a los dos siguientes.
    periodMonth: request.periodType === "QUARTERLY"
      ? { gte: request.month, lte: request.month + 2 }
      : request.month,
    ...(request.type !== "ALL" ? { type: request.type } : {}),
  };
}

/**
 * Barrera de la descarga (POST): que venga de la propia app y no de otra web.
 *
 * - Content-Type exactamente application/json. Un formulario de otra web solo
 *   puede mandar text/plain, urlencoded o multipart sin preflight; con
 *   `.includes()` pasaba "text/plain;x=application/json".
 * - Sec-Fetch-Site, si viene, same-origin: lo pone el navegador, no la pagina.
 * - Sin Sec-Fetch-Site (navegadores viejos), si viene Origin, su host tiene
 *   que ser el de la peticion. Detras del proxy de Coolify el host publico
 *   llega en x-forwarded-host (o host); la URL interna no sirve. Sin Origin
 *   no se rechaza: no hay con que comparar.
 */
export function exportPostHeadersError(headers: {
  contentType: string | null;
  secFetchSite: string | null;
  origin: string | null;
  host: string | null;
  forwardedHost: string | null;
}): { status: 415 | 403; error: string } | null {
  const mediaType = (headers.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { status: 415, error: "Se esperaba JSON." };
  }
  if (headers.secFetchSite) {
    return headers.secFetchSite === "same-origin" ? null : { status: 403, error: "Origen no permitido." };
  }
  if (headers.origin) {
    const requestHost = (headers.forwardedHost ?? headers.host ?? "").split(",")[0].trim().toLowerCase();
    let originHost = "";
    try {
      originHost = new URL(headers.origin).host.toLowerCase();
    } catch {
      // "null" (documento sin origen) u otra cosa que no es una URL.
    }
    if (!originHost || originHost !== requestHost) {
      return { status: 403, error: "Origen no permitido." };
    }
  }
  return null;
}
