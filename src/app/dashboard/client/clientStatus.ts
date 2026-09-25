import type { InvoiceStatus } from "@prisma/client";
import type { BadgeVariant } from "@/components/ui/Badge";

type ClientStatusBadge = { label: string; variant: BadgeVariant };

const EN_PROCESO: ClientStatusBadge = { label: "En proceso", variant: "yellow" };
const VALIDADA: ClientStatusBadge = { label: "Validada", variant: "green" };

/**
 * Estado de una factura tal como lo ve el cliente. Los estados internos del
 * gestor ("Por revisar", "Con incidencias", "Error OCR") no los puede
 * resolver el y le alarmaban: para el todo eso es "En proceso", igual que el
 * contador de su panel. Solo el rechazo le pide algo (subir otra version).
 */
export const CLIENT_STATUS_BADGE: Record<InvoiceStatus, ClientStatusBadge> = {
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
