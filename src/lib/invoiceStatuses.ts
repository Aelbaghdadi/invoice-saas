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

/** Estados activos del flujo nuevo. No incluye legacy. */
export const STATUS_UPLOADED:        InvoiceStatus = "UPLOADED";
export const STATUS_ANALYZING:       InvoiceStatus = "ANALYZING";
export const STATUS_PENDING_REVIEW:  InvoiceStatus = "PENDING_REVIEW";
export const STATUS_NEEDS_ATTENTION: InvoiceStatus = "NEEDS_ATTENTION";
export const STATUS_OCR_ERROR:       InvoiceStatus = "OCR_ERROR";
export const STATUS_VALIDATED:       InvoiceStatus = "VALIDATED";
export const STATUS_REJECTED:        InvoiceStatus = "REJECTED";

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
];

/** Solo las validadas (exportables). */
export const EXPORTABLE: InvoiceStatus[] = ["VALIDATED"];

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
  PENDING_REVIEW:   "Pte. revisión",
  NEEDS_ATTENTION:  "Con incidencias",
  VALIDATED:        "Validada",
  REJECTED:         "Rechazada",
  EXPORTED:         "Exportada",        // legacy
};
