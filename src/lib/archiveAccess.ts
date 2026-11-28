/**
 * Quién entra en el archivo (R22). Lo usan las rutas y las páginas nuevas, que
 * comprueban también la asesoría del ADMIN. El portal (CLIENT) no tiene
 * archivo en esta fase.
 */
import type { Prisma } from "@prisma/client";
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

/** Quien mira tandas y tacos (B-R20): `clientIds`, los de archiveScope. */
export type TacoViewer = { firmId: string; userId: string; role: "ADMIN" | "WORKER"; clientIds: string[] };

/** El que mira tandas y tacos, con los clientes de archiveScope; null si no entra. */
export async function tacoViewer(session: ArchiveSession): Promise<TacoViewer | null> {
  const scope = await archiveScope(session);
  if (!scope) return null;
  return {
    firmId: scope.firmId,
    userId: session.user.id,
    role: session.user.role === "ADMIN" ? "ADMIN" : "WORKER",
    clientIds: scope.clientIds,
  };
}

/**
 * Las tandas (y tacos) que ve (B-R20). El ADMIN, todas las de su asesoría. El
 * WORKER:
 * - con cliente, solo si lo tiene asignado (aunque la creara él: si le quitan
 *   el cliente, deja de ver su PDF, de dividirlo y de guardarlo);
 * - de varios (sin cliente), si la creó él, si tiene asignado alguno de sus
 *   candidatos (mientras esperan el ruteo, sus facturas están en el buzón) o
 *   el cliente de alguna factura que llegó en ella o cuyo papel está en ella.
 * Es la única definición: canAccessUploadBatch la usa para una tanda, y los
 * listados, avisos y cifras de tacos para filtrar.
 */
export function uploadBatchVisibleWhere(viewer: TacoViewer): Prisma.UploadBatchWhereInput {
  if (viewer.role === "ADMIN") return { advisoryFirmId: viewer.firmId };
  const ofMyClients = { invoice: { clientId: { in: viewer.clientIds } } };
  return {
    advisoryFirmId: viewer.firmId,
    OR: [
      { clientId: { in: viewer.clientIds } },
      {
        clientId: null,
        OR: [
          { createdById: viewer.userId },
          { routingCandidateIds: { hasSome: viewer.clientIds } },
          { archives: { some: ofMyClients } },
          { paperArchives: { some: ofMyClients } },
        ],
      },
    ],
  };
}

/** ¿Puede ver esta tanda (o taco)? Con el criterio de uploadBatchVisibleWhere. */
export async function canAccessUploadBatch(session: ArchiveSession, batchId: string): Promise<boolean> {
  const viewer = await tacoViewer(session);
  if (!viewer) return false;
  const found = await prisma.uploadBatch.count({ where: { AND: [{ id: batchId }, uploadBatchVisibleWhere(viewer)] } });
  return found > 0;
}

/**
 * Clientes cuyas facturas ve sin enmascarar en el detalle y la hoja de un
 * taco: el ADMIN, todos ("all"); el WORKER, los suyos de la asesoría. Nadie
 * más, ninguno.
 */
export async function visibleClientIds(session: ArchiveSession): Promise<Set<string> | "all"> {
  const viewer = await tacoViewer(session);
  if (!viewer) return new Set();
  return viewer.role === "ADMIN" ? "all" : new Set(viewer.clientIds);
}
