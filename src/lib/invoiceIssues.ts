/**
 * Cierre de incidencias (F-057). Antes no se cerraban nunca: una factura
 * validada, rechazada o reprocesada seguia con sus incidencias abiertas y
 * contaba en «Con incidencias» para siempre.
 *
 * Todas las incidencias las crea el sistema (OCR, clasificar); ninguna la
 * escribe un gestor a mano, asi que cerrarlas no pierde nada suyo:
 *  - al validar: el gestor ha revisado y confirmado los datos, y validar ya
 *    exige total, cuadre, cuentas y NIF (F-009); un duplicado abierto pide
 *    confirmacion antes. Se cierran todas.
 *  - al rechazar: la factura sale del flujo. Se cierran todas.
 *  - al reprocesar: el OCR vuelve a crear las que apliquen a la nueva
 *    lectura. Se cierran las anteriores.
 */
import type { Prisma } from "@prisma/client";

export async function closeOpenIssues(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  userId: string | null,
): Promise<number> {
  const { count } = await tx.invoiceIssue.updateMany({
    where: { invoiceId, status: "OPEN" },
    data: { status: "RESOLVED", resolvedBy: userId, resolvedAt: new Date() },
  });
  return count;
}
