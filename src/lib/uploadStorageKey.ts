import { randomUUID } from "crypto";
import type { PeriodTypeName } from "@/lib/period";

/** Carpeta del lote: «2026-09» o, en un lote trimestral, «2026-T3». */
export function uploadPeriodSegment(period: { periodType: PeriodTypeName; periodMonth: number; periodYear: number }): string {
  return period.periodType === "QUARTERLY"
    ? `${period.periodYear}-T${Math.ceil(period.periodMonth / 3)}`
    : `${period.periodYear}-${String(period.periodMonth).padStart(2, "0")}`;
}

/**
 * Clave en el almacenamiento de una factura subida (o resubida, con la
 * etiqueta «reupload»). Única por llamada, como splitStorageKey: con solo
 * Date.now() y el nombre, dos subidas del mismo fichero en el mismo
 * milisegundo compartían objeto y la segunda sobrescribía el original de la
 * primera. Va siempre bajo el prefijo del cliente, que es lo que borra el
 * reset de la demo.
 */
export function uploadStorageKey(
  target: { clientId: string; periodType: PeriodTypeName; periodMonth: number; periodYear: number },
  safeName: string,
  options: { tag?: "reupload"; now?: number; unique?: string } = {},
): string {
  const { tag, now = Date.now(), unique = randomUUID() } = options;
  return `${target.clientId}/${uploadPeriodSegment(target)}/${now}-${unique}-${tag ? `${tag}-` : ""}${safeName}`;
}

/**
 * Clave de un original en otro formato (Word, Excel…) adjunto a una factura
 * (anexo C19): bajo el prefijo del cliente, como todo lo suyo, y con UUID.
 */
export function originalAttachmentKey(
  clientId: string,
  safeName: string,
  options: { now?: number; unique?: string } = {},
): string {
  const { now = Date.now(), unique = randomUUID() } = options;
  return `${clientId}/originales/${now}-${unique}-${safeName}`;
}
