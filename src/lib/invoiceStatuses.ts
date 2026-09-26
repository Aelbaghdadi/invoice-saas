/**
 * Constantes compartidas sobre el ciclo de vida de Invoice.
 *
 * El enum del schema incluye valores legacy (ANALYZED, EXPORTED) que ya no
 * escribe ningun codigo en la version actual, pero pueden existir en BD por
 * historial. Aqui los tratamos como "legacy" y los contamos aparte.
 *
 * Flujo canonico:
 *   UPLOADED → ANALYZING → (PENDING_REVIEW | NEEDS_ATTENTION | OCR_ERROR)
 *                        → VALIDATED | REJECTED
 *
 * La "exportacion" no cambia el estado: se registra en ExportBatch /
 * ExportBatchItem. Invoice.exportBatchId es un puntero al ultimo export,
 * util para mostrar "ya exportada" en la UI sin perder el estado real.
 */

import type { InvoiceStatus } from "@prisma/client";
import { OPERATION_TYPE_LABEL, INTRACOM_GOODS_TYPE_LABEL } from "@/lib/validators";

/** Pte. de que el gestor haga algo (revisar, re-procesar o subir). */
export const PENDING_WORK: InvoiceStatus[] = [
  "UPLOADED",
  "ANALYZING",
  "PENDING_REVIEW",
  "NEEDS_ATTENTION",
  "OCR_ERROR",
  // Legacy: si aun existen ANALYZED en BD, siguen siendo "pte" hasta validar
  "ANALYZED",
];

/** Necesitan accion manual del gestor (formularios de revision). */
export const NEEDS_REVIEW: InvoiceStatus[] = [
  "PENDING_REVIEW",
  "NEEDS_ATTENTION",
  "OCR_ERROR",
];

/** Trabajo terminado (independientemente de si se valida o rechaza). */
export const DONE_WORK: InvoiceStatus[] = [
  "VALIDATED",
  "REJECTED",
  // Legacy: EXPORTED equivale a VALIDATED + exportada. Contamos como "done".
  "EXPORTED",
  // Foto con múltiples tickets que fue dividida en sub-facturas.
  "SPLIT_SOURCE",
];

/** Calcula el porcentaje completado de un conjunto. */
export function completionPercent(counts: {
  total: number;
  validated: number;
  rejected: number;
  exported?: number;
}): number {
  if (counts.total <= 0) return 0;
  const done = counts.validated + counts.rejected + (counts.exported ?? 0);
  return Math.round((done / counts.total) * 100);
}

/** Status legacy que ya no produce el codigo actual. Mantenido por compat. */
export const LEGACY_STATUSES: InvoiceStatus[] = ["ANALYZED", "EXPORTED"];

/** Labels unificadas para la UI (una sola fuente de verdad). */
export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  UPLOADED:         "Subida",
  ANALYZING:        "En análisis",
  ANALYZED:         "Analizada",       // legacy
  OCR_ERROR:        "Error OCR",
  // "Pte." no es la abreviatura de pendiente, y "Pdte." en otras pantallas.
  // Sin abreviar es igual de corto y no hay duda.
  PENDING_REVIEW:   "Por revisar",
  NEEDS_ATTENTION:  "Con incidencias",
  VALIDATED:        "Validada",
  REJECTED:         "Rechazada",
  EXPORTED:         "Exportada",        // legacy
  SPLIT_SOURCE:     "Dividida",
  // Subida en modo clasificar, pendiente de auto-ruteo/clasificación manual.
  // No entra en PENDING_WORK/NEEDS_REVIEW/DONE_WORK: queda fuera de colas y
  // contadores normales hasta que se asigna a su cliente real.
  PENDING_ROUTING:  "Por clasificar",
};

/** Color del distintivo de cada estado. Estaba copiado en cada pantalla, y
 *  un estado que faltaba en una copia salia como "Subida". */
export const STATUS_BADGE_VARIANT: Record<InvoiceStatus, "blue" | "yellow" | "green" | "slate" | "red" | "purple" | "orange"> = {
  UPLOADED:        "blue",
  ANALYZING:       "yellow",
  ANALYZED:        "yellow",
  OCR_ERROR:       "red",
  PENDING_REVIEW:  "blue",
  NEEDS_ATTENTION: "yellow",
  VALIDATED:       "green",
  REJECTED:        "red",
  EXPORTED:        "slate",
  SPLIT_SOURCE:    "purple",
  PENDING_ROUTING: "orange",
};

type StatusBadge = { label: string; variant: (typeof STATUS_BADGE_VARIANT)[InvoiceStatus] };

const EN_PROCESO: StatusBadge = { label: "En proceso", variant: "yellow" };
const VALIDADA: StatusBadge = { label: "Validada", variant: "green" };

/**
 * Estado de una factura tal como lo ve el cliente. Los estados internos del
 * gestor ("Por revisar", "Con incidencias", "Error OCR") no los puede
 * resolver el y le alarmaban: para el todo eso es "En proceso", igual que el
 * contador de su panel. Solo el rechazo le pide algo (subir otra version).
 * Aqui y no en el portal porque tambien lo usa la API de subida (el aviso de
 * duplicado lleva el estado de la factura que ya estaba).
 */
export const CLIENT_STATUS_BADGE: Record<InvoiceStatus, StatusBadge> = {
  UPLOADED:        EN_PROCESO,
  ANALYZING:       EN_PROCESO,
  ANALYZED:        EN_PROCESO, // legacy
  PENDING_REVIEW:  EN_PROCESO,
  NEEDS_ATTENTION: EN_PROCESO,
  OCR_ERROR:       EN_PROCESO,
  PENDING_ROUTING: EN_PROCESO,
  VALIDATED:       VALIDADA,
  EXPORTED:        VALIDADA, // legacy: validada y ya exportada
  REJECTED:        { label: "Rechazada", variant: "red" },
  SPLIT_SOURCE:    { label: "Dividida", variant: "purple" },
};

/**
 * Nombre de cada campo de la auditoria tal como lo ve el gestor. Habia tres
 * copias que no coincidian (pantalla de auditoria, su filtro y la actividad
 * reciente del panel) y a ninguna le constaban campos que si se auditan, asi
 * que salian en crudo: "operationType", "isRectificative"...
 */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  status: "Estado",
  type: "Tipo (emitida/recibida)",
  issuerName: "Emisor",
  issuerCif: "CIF emisor",
  receiverName: "Receptor",
  receiverCif: "CIF receptor",
  invoiceNumber: "Nº factura",
  invoiceDate: "Fecha",
  taxBase: "Base imponible",
  vatRate: "% IVA",
  vatAmount: "Cuota IVA",
  irpfRate: "% IRPF",
  irpfAmount: "Cuota IRPF",
  totalAmount: "Total",
  currency: "Moneda",
  operationType: "Tipo de operación",
  intracomGoodsType: "Bienes o servicios",
  isRectificative: "Rectificativa",
  rectifiedInvoiceNumber: "Factura rectificada",
  rectificativeType: "Tipo de rectificación",
  equivalenceSurcharge: "Recargo de equivalencia",
  export: "Exportación",
  reexport: "Por reexportar",
  duplicate_warning: "Posible duplicado",
};

/** Nombre legible de un campo de la auditoria (el propio nombre si no se conoce). */
export function auditFieldLabel(field: string): string {
  return AUDIT_FIELD_LABELS[field] ?? field;
}

/** Tipo de operación (emitida/recibida) para la UI. */
export const OPERATION_LABELS: Record<string, string> = {
  PURCHASE: "Recibida",
  SALE: "Emitida",
  UNKNOWN: "Sin determinar",
};

/**
 * Traduce un valor almacenado en AuditLog (`oldValue` / `newValue`) al español
 * para mostrarlo en la UI. Cubre los estados de factura, el tipo de operación
 * y el compuesto "<ESTADO> (reprocess)" que escribe el reproceso manual. Los
 * valores libres (importes, nombres, CIFs...) se devuelven tal cual.
 */
export function formatAuditValue(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  // "(reprocess masivo)" es como lo escribia el reproceso en bloque: la
  // auditoria es inmutable y esas filas se siguen viendo.
  const reproc = value.match(/^(.+?)\s*\(reprocess(?: masivo)?\)$/i);
  if (reproc) {
    const base = reproc[1];
    const label =
      STATUS_LABELS[base as InvoiceStatus] ?? OPERATION_LABELS[base] ?? base;
    return `${label} (reprocesar)`;
  }
  if (value === "true") return "Sí";
  if (value === "false") return "No";
  return (
    STATUS_LABELS[value as InvoiceStatus]
    ?? OPERATION_LABELS[value]
    ?? OPERATION_TYPE_LABEL[value as keyof typeof OPERATION_TYPE_LABEL]
    ?? INTRACOM_GOODS_TYPE_LABEL[value as keyof typeof INTRACOM_GOODS_TYPE_LABEL]
    ?? value
  );
}

/** Estados que impiden cerrar un periodo: facturas aun sin procesar del todo.
 *  La pagina de lotes y la accion de cerrar periodo usan esta misma lista; con
 *  criterios distintos el boton aparecia o desaparecia sin motivo. */
export const PERIOD_BLOCKING_STATUSES: InvoiceStatus[] = [
  "UPLOADED", "ANALYZING", "ANALYZED", "PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR",
];

/** Estados que "Rechazar lote" nunca toca:
 *  - REJECTED: ya lo estan.
 *  - EXPORTED (legacy): ya estan en la contabilidad del cliente.
 *  - SPLIT_SOURCE: la foto original de una division; sus hijas si entran.
 *  - PENDING_ROUTING: viven en el buzon "Sin clasificar".
 *  - UPLOADED / ANALYZING: el OCR en curso las devolveria a revision al
 *    terminar y desharia el rechazo sin dejar rastro.
 *  La accion y las dos pantallas de lotes (gestor y admin) usan esta lista:
 *  con copias a mano, lo que el boton anunciaba y lo que se rechazaba de
 *  verdad acababan sin cuadrar. */
export const BATCH_REJECT_EXCLUDED_STATUSES: InvoiceStatus[] = [
  "REJECTED", "EXPORTED", "SPLIT_SOURCE", "PENDING_ROUTING", "UPLOADED", "ANALYZING",
];

/** Si "Rechazar lote" tocaria esta factura. Exportar no cambia el estado
 *  (queda VALIDATED + exportBatchId), por eso hay que mirar el historial.
 *
 *  Se mira si la factura SALIO ALGUNA VEZ en un Excel (tiene ExportBatchItem),
 *  no el puntero exportBatchId: corregir una factura exportada lo pone a null
 *  para que vuelva a la cola, y con el puntero a secas una factura que ya esta
 *  en la contabilidad del cliente volvia a poder rechazarse en bloque. */
export function isBatchRejectable(invoice: {
  status: InvoiceStatus;
  exportBatchItems?: { id: string }[];
}): boolean {
  const seExporto = (invoice.exportBatchItems?.length ?? 0) > 0;
  return !seExporto && !BATCH_REJECT_EXCLUDED_STATUSES.includes(invoice.status);
}

/**
 * Condicion con la que el OCR escribe su resultado (F-008): la factura sigue
 * en ANALYZING y con el mismo `ocrAttempts` que dejo su claim. `ocrAttempts`
 * hace de fencing token: si mientras analizaba alguien la rechazo, la dividio
 * o la valido, o el cron la relanzo (otro claim, otro numero), esta ejecucion
 * ya no es la duena y no pisa nada.
 */
export function ocrFenceWhere(invoiceId: string, ocrAttempts: number) {
  return { id: invoiceId, status: "ANALYZING" as const, ocrAttempts };
}

/** Maximo de intentos de OCR que relanza el cron de rescate. */
export const MAX_OCR_RETRIES = 3;

/**
 * Facturas atascadas en ANALYZING: sin tocar desde `cutoff`. El cron la usa
 * al leer y otra vez en el propio updateMany que las devuelve a UPLOADED, para
 * no resetear una que el OCR ha terminado entre la lectura y la escritura.
 */
export function stuckAnalyzingWhere(cutoff: Date) {
  return { status: "ANALYZING" as const, updatedAt: { lt: cutoff }, ocrAttempts: { lt: MAX_OCR_RETRIES } };
}
