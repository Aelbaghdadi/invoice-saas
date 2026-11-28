import { prisma } from "@/lib/prisma";

type SessionUser = { id: string; role: string; advisoryFirmId?: string | null };

/** Lo que hace falta de la factura: su cliente, los candidatos del buzón y la
 *  asesoría del cliente. */
export type InvoiceForAccess = {
  clientId: string;
  routingCandidateIds: string[];
  client: { advisoryFirmId: string };
};

/** El select de Prisma que da un InvoiceForAccess. */
export const INVOICE_ACCESS_SELECT = {
  clientId: true,
  routingCandidateIds: true,
  client: { select: { advisoryFirmId: true } },
} as const;

/**
 * ¿Puede este usuario VER esta factura (preview / descarga del binario)?
 * Misma regla que comparten /preview y el stream /raw, para no divergir:
 *  - ADMIN: si la factura es de un cliente de su asesoría. Antes pasaba sin
 *    mirarla y, con el id, se descargaba el PDF de otra asesoría.
 *  - WORKER: dentro de su asesoría, si tiene el cliente asignado o —para "por
 *    clasificar"— alguno de los clientes candidatos del lote.
 *  - CLIENT: solo sus propias facturas.
 */
export async function canReadInvoice(user: SessionUser, invoice: InvoiceForAccess): Promise<boolean> {
  if (user.role === "ADMIN" || user.role === "WORKER") {
    if (!user.advisoryFirmId || invoice.client.advisoryFirmId !== user.advisoryFirmId) return false;
    if (user.role === "ADMIN") return true;
    const assignment = await prisma.workerClientAssignment.findFirst({
      where: { workerId: user.id, clientId: { in: [invoice.clientId, ...invoice.routingCandidateIds] } },
      select: { clientId: true },
    });
    return assignment != null;
  }

  if (user.role === "CLIENT") {
    const client = await prisma.client.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    return Boolean(client && client.id === invoice.clientId);
  }

  return false;
}
