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
