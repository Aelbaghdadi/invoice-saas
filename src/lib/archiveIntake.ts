/**
 * La fila de archivo de una factura recién subida (R11 y anexo C2). La crea el
 * trigger invoice_archive_row al insertar la factura, con la llegada = alta;
 * quien sube la completa con esto, con un update en la misma transacción.
 * Módulo puro: lo usan /api/uploads y la resubida del portal.
 */
import type { OriginalMedium, OriginalMediumSource } from "@prisma/client";
import { archiveFileKind, proposeOriginalMedium } from "@/lib/originalMedium";

export type ArchiveIntakeFields = {
  originalMedium?: OriginalMedium | null;
  originalMediumSource?: OriginalMediumSource;
  originalMediumReason?: string;
  paperHeldByClient?: true;
};

/**
 * - Un XML es el original electrónico y una imagen queda «Por confirmar»: lo
 *   dice el tipo de fichero.
 * - Un PDF no se decide aquí: el análisis lee su capa de texto y su productor.
 * - En un taco (papel escaneado en la asesoría), el PDF o la foto es papel
 *   desde el alta, con origen TACO, que el análisis ya no pisa (R11). Un XML
 *   sigue siendo electrónico: la ruta lo rechaza antes en un taco.
 * - Lo que sube un usuario CLIENT (y su resubida) lo guarda el cliente: es lo
 *   único que la app marca así sola. El CLIENT nunca sube en un taco.
 * null si no hay nada que escribir.
 */
export function archiveIntakeFields(input: {
  fileType: string;
  uploadedByClient: boolean;
  inTaco?: boolean;
}): ArchiveIntakeFields | null {
  const fields: ArchiveIntakeFields = {};
  if (input.inTaco || archiveFileKind(input.fileType) !== "pdf") {
    const proposal = proposeOriginalMedium({ fileType: input.fileType, inTaco: input.inTaco });
    fields.originalMedium = proposal.medium;
    fields.originalMediumSource = proposal.source;
    fields.originalMediumReason = proposal.reason;
  }
  if (input.uploadedByClient) fields.paperHeldByClient = true;
  return Object.keys(fields).length > 0 ? fields : null;
}
