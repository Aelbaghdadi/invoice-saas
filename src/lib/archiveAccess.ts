/**
 * Quién entra en el archivo (R22). Lo usan las rutas y las páginas nuevas, que
 * comprueban también la asesoría del ADMIN: no reutilizan canReadInvoice, que
 * al ADMIN le deja pasar sin mirarla. El portal (CLIENT) no tiene archivo en
 * esta fase.
 */
import { prisma } from "@/lib/prisma";
import { getAccessibleClientIds } from "@/lib/accessibleClients";

export type ArchiveSession = { user: { id: string; role: string; advisoryFirmId?: string | null } };

/** Asesoría y clientes que ve en el archivo. Los listados, la búsqueda y las
 *  métricas filtran por los dos. */
export type ArchiveScope = { firmId: string; clientIds: string[] };

/**
 * ADMIN: todos los clientes de su asesoría. WORKER: los que tiene asignados,
 * y solo si son de su asesoría (la asignación sola no lo garantiza). Sin el
 * buzón «Sin clasificar». null si no entra.
 */
export async function archiveScope(session: ArchiveSession): Promise<ArchiveScope | null> {
  const { role, advisoryFirmId } = session.user;
  if ((role !== "ADMIN" && role !== "WORKER") || !advisoryFirmId) return null;
  const ids = await getAccessibleClientIds(session);
  if (role === "ADMIN") return { firmId: advisoryFirmId, clientIds: ids };
  const own = await prisma.client.findMany({
    where: { id: { in: ids }, advisoryFirmId, isUnclassifiedBucket: false },
    select: { id: true },
  });
  return { firmId: advisoryFirmId, clientIds: own.map((c) => c.id) };
}

/**
 * ¿Puede ver esta factura en el archivo (su ficha y su original)?
 * - ADMIN: si el cliente de la factura es de su asesoría.
 * - WORKER: si tiene asignado el cliente o, si está en el buzón, alguno de sus
 *   candidatos; siempre dentro de su asesoría.
 */
export async function canAccessArchiveInvoice(session: ArchiveSession, invoiceId: string): Promise<boolean> {
  const { id: userId, role, advisoryFirmId } = session.user;
  if ((role !== "ADMIN" && role !== "WORKER") || !advisoryFirmId) return false;
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      clientId: true,
      routingCandidateIds: true,
      client: { select: { advisoryFirmId: true, isUnclassifiedBucket: true } },
    },
  });
  if (!invoice || invoice.client.advisoryFirmId !== advisoryFirmId) return false;
  if (role === "ADMIN") return true;
  const clientIds = invoice.client.isUnclassifiedBucket
    ? [invoice.clientId, ...invoice.routingCandidateIds]
    : [invoice.clientId];
  const assignment = await prisma.workerClientAssignment.findFirst({
    where: { workerId: userId, clientId: { in: clientIds }, client: { advisoryFirmId } },
    select: { clientId: true },
  });
  return assignment != null;
}

/**
 * ¿Puede ver esta tanda (o taco)? El ADMIN, si es de su asesoría. El WORKER,
 * si es de un cliente suyo o la subió él (las de «varios» no tienen cliente).
 */
export async function canAccessUploadBatch(session: ArchiveSession, batchId: string): Promise<boolean> {
  const { id: userId, role, advisoryFirmId } = session.user;
  if ((role !== "ADMIN" && role !== "WORKER") || !advisoryFirmId) return false;
  const batch = await prisma.uploadBatch.findUnique({
    where: { id: batchId },
    select: { advisoryFirmId: true, clientId: true, createdById: true },
  });
  if (!batch || batch.advisoryFirmId !== advisoryFirmId) return false;
  if (role === "ADMIN" || batch.createdById === userId) return true;
  if (!batch.clientId) return false;
  const assignment = await prisma.workerClientAssignment.findUnique({
    where: { workerId_clientId: { workerId: userId, clientId: batch.clientId } },
    select: { clientId: true },
  });
  return assignment != null;
}
