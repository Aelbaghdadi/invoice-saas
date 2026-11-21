import type { InvoiceStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * El reparto de una subida «Clasificar entre varios»: las facturas viven en el
 * cliente técnico «Sin clasificar» (unclassifiedClient.ts) hasta que el OCR
 * las asigna por CIF o el gestor las clasifica. Lo comparten la pantalla de
 * reparto, el contador del menú y los avisos del inicio.
 */

/** Las del buzón que este usuario puede ver: alguna de sus empresas está
 *  entre las candidatas. Sin empresas accesibles no casa ninguna. */
export function routingInboxWhere(accessibleClientIds: string[]): Prisma.InvoiceWhereInput {
  return { client: { isUnclassifiedBucket: true }, routingCandidateIds: { hasSome: accessibleClientIds } };
}

/** Lo que necesita a alguien: asignarla a mano o volver a leerla. */
export const ROUTING_NEEDS_ACTION: InvoiceStatus[] = ["PENDING_ROUTING", "OCR_ERROR"];

/** Lo que aún se está leyendo (en cola o analizándose). */
export const ROUTING_IN_PROGRESS: InvoiceStatus[] = ["UPLOADED", "ANALYZING"];

/** Cuántas del buzón necesitan a alguien (el contador del menú y el aviso del inicio). */
export async function routingNeedsActionCount(accessibleClientIds: string[]): Promise<number> {
  if (accessibleClientIds.length === 0) return 0;
  return prisma.invoice.count({
    where: { ...routingInboxWhere(accessibleClientIds), status: { in: ROUTING_NEEDS_ACTION } },
  });
}

/** Días que cuenta «Repartidas recientemente». */
export const RECENTLY_ROUTED_DAYS = 7;

/**
 * Las que salieron del buzón a una empresa en los últimos días, por empresa.
 * Se reconocen por su Document, que sigue siendo del buzón: la factura cambia
 * de cliente al rutearse o clasificarse y el documento subido no.
 */
export async function recentlyRoutedByClient(
  accessibleClientIds: string[],
  now: Date = new Date(),
): Promise<{ clientId: string; name: string; count: number }[]> {
  if (accessibleClientIds.length === 0) return [];
  const since = new Date(now.getTime() - RECENTLY_ROUTED_DAYS * 24 * 60 * 60 * 1000);
  const groups = await prisma.invoice.groupBy({
    by: ["clientId"],
    where: {
      clientId: { in: accessibleClientIds },
      client: { isUnclassifiedBucket: false },
      document: { client: { isUnclassifiedBucket: true } },
      createdAt: { gte: since },
    },
    _count: { _all: true },
  });
  if (groups.length === 0) return [];
  const clients = await prisma.client.findMany({
    where: { id: { in: groups.map((g) => g.clientId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  return groups
    .map((g) => ({ clientId: g.clientId, name: nameById.get(g.clientId) ?? "—", count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "es"));
}
