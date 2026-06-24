import { prisma } from "@/lib/prisma";

type SessionUser = { id: string; role: string };

/**
 * ¿Puede este usuario VER esta factura (preview / descarga del binario)?
 * Misma regla que comparten /preview y el stream /raw, para no divergir:
 *  - ADMIN: sí (las queries de su firma ya acotan qué facturas llegan a la UI).
 *  - WORKER: si tiene el cliente asignado, o —para "por clasificar"— si tiene
 *    asignado alguno de los clientes candidatos del lote.
 *  - CLIENT: solo sus propias facturas.
 */
export async function canReadInvoice(
  user: SessionUser,
  invoice: { clientId: string; routingCandidateIds: string[] },
): Promise<boolean> {
  if (user.role === "ADMIN") return true;

  if (user.role === "WORKER") {
    const assignment = await prisma.workerClientAssignment.findUnique({
      where: { workerId_clientId: { workerId: user.id, clientId: invoice.clientId } },
    });
    if (assignment) return true;
    if (invoice.routingCandidateIds.length > 0) {
      const candidate = await prisma.workerClientAssignment.findFirst({
        where: { workerId: user.id, clientId: { in: invoice.routingCandidateIds } },
      });
      return Boolean(candidate);
    }
    return false;
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
