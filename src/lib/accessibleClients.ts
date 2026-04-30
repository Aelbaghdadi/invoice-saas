import { prisma } from "@/lib/prisma";

/**
 * Devuelve los clientIds visibles para un usuario en zonas de "gestor".
 *
 * - **ADMIN**: ve todos los clientes de su asesoria (advisoryFirmId).
 * - **WORKER**: solo los clientes que tiene asignados.
 * - **CLIENT** u otros: arreglo vacio (las zonas worker no son suyas).
 *
 * El admin no necesita tener WorkerClientAssignment para acceder a las
 * pantallas /dashboard/worker/*; es el "supergestor" de su firma.
 */
export async function getAccessibleClientIds(session: {
  user: { id: string; role: string; advisoryFirmId?: string | null };
}): Promise<string[]> {
  const { id, role, advisoryFirmId } = session.user;

  if (role === "ADMIN") {
    if (!advisoryFirmId) return [];
    const clients = await prisma.client.findMany({
      where: { advisoryFirmId },
      select: { id: true },
    });
    return clients.map((c) => c.id);
  }

  if (role === "WORKER") {
    const assignments = await prisma.workerClientAssignment.findMany({
      where: { workerId: id },
      select: { clientId: true },
    });
    return assignments.map((a) => a.clientId);
  }

  return [];
}

/**
 * Comprueba si un usuario puede acceder a un cliente concreto.
 * - ADMIN: si el cliente pertenece a su firma.
 * - WORKER: si tiene asignacion.
 */
export async function canAccessClient(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  clientId: string,
): Promise<boolean> {
  const { id, role, advisoryFirmId } = session.user;

  if (role === "ADMIN") {
    if (!advisoryFirmId) return false;
    const c = await prisma.client.findUnique({
      where: { id: clientId },
      select: { advisoryFirmId: true },
    });
    return c?.advisoryFirmId === advisoryFirmId;
  }

  if (role === "WORKER") {
    const a = await prisma.workerClientAssignment.findUnique({
      where: { workerId_clientId: { workerId: id, clientId } },
    });
    return Boolean(a);
  }

  return false;
}
