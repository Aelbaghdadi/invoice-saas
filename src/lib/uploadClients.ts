import type { Prisma } from "@prisma/client";

/**
 * Filtro de los clientes que un ADMIN puede elegir en "Subir facturas": los
 * de su asesoría, sin el cliente técnico "Sin clasificar".
 *
 * Sin asesoría en la sesión devuelve null (lista vacía). Nunca
 * `advisoryFirmId: undefined`: Prisma ignora el campo y devolvería los
 * clientes de todas las asesorías (F-005).
 */
export function adminUploadClientsWhere(
  advisoryFirmId: string | null | undefined,
): Prisma.ClientWhereInput | null {
  if (!advisoryFirmId) return null;
  return { advisoryFirmId, isUnclassifiedBucket: false };
}
