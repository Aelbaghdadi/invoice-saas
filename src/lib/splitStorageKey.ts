import { randomUUID } from "crypto";

/**
 * Clave en el almacenamiento de una parte de una division. Unica por llamada:
 * con solo Date.now() y la posicion, dos divisiones de la misma factura en el
 * mismo milisegundo generaban la misma clave, y la limpieza de la que perdia
 * la reserva borraba el fichero de la que ganaba.
 */
export function splitStorageKey(
  invoice: { clientId: string; periodYear: number; periodMonth: number },
  safeName: string,
  now: number = Date.now(),
  unique: string = randomUUID(),
): string {
  const period = `${invoice.periodYear}-${String(invoice.periodMonth).padStart(2, "0")}`;
  return `${invoice.clientId}/${period}/${now}-${unique}-split-${safeName}`;
}
