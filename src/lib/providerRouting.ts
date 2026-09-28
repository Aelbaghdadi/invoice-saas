import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseTaxId } from "@/lib/validators";

/**
 * Aprendizaje de ruteo por proveedor.
 *
 * Idea: en facturas recibidas el CIF del restaurante (receptor) muchas veces no
 * está legible, así que el match por CIF del cliente falla. Pero el CIF del
 * PROVEEDOR (emisor) sí suele estar. Cuando el gestor clasifica a mano una
 * factura de un proveedor, recordamos "proveedor X → empresa A" para auto-rutear
 * las siguientes de ese proveedor. Si el mismo proveedor se clasifica a dos
 * empresas distintas, se marca ambiguo y deja de auto-rutear (no adivinamos).
 */

/** El CIF del proveedor como se guarda en la regla (limpio, en mayusculas). */
export function normalizeProviderNif(nif: string | null | undefined): string {
  return parseTaxId(nif).clean.toUpperCase();
}

/**
 * Aprende/actualiza la regla proveedor→empresa. No-op si no hay CIF de
 * proveedor.
 * - Primera vez: se crea. Si otro gestor la crea a la vez (P2002 del
 *   indice unico), se reintenta ya como actualizacion.
 * - Misma empresa: sube la confianza. Una regla ambigua sigue ambigua: que
 *   el proveedor vuelva a la empresa de antes no quita que tambien factura
 *   a otra del grupo.
 * - Otra empresa: ambigua, y deja de auto-rutear.
 */
export async function learnProviderRule(
  firmId: string,
  providerNif: string | null | undefined,
  clientId: string,
): Promise<void> {
  const nif = normalizeProviderNif(providerNif);
  if (!nif) return;
  const key = { advisoryFirmId_providerNif: { advisoryFirmId: firmId, providerNif: nif } };

  for (let attempt = 0; ; attempt++) {
    const existing = await prisma.providerRoutingRule.findUnique({ where: key });
    if (!existing) {
      try {
        await prisma.providerRoutingRule.create({
          data: { advisoryFirmId: firmId, providerNif: nif, clientId },
        });
        return;
      } catch (err) {
        if (attempt === 0 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    if (existing.clientId === clientId) {
      await prisma.providerRoutingRule.update({
        where: { id: existing.id },
        data: { hitCount: { increment: 1 }, lastSeenAt: new Date() },
      });
    } else {
      await prisma.providerRoutingRule.update({
        where: { id: existing.id },
        data: { ambiguous: true, clientId, lastSeenAt: new Date() },
      });
    }
    return;
  }
}

/** Empresa aprendida para un proveedor, o null si no hay regla o es ambigua. */
export async function lookupProviderClient(
  firmId: string,
  providerNif: string | null | undefined,
): Promise<string | null> {
  const nif = normalizeProviderNif(providerNif);
  if (!nif) return null;
  const rule = await prisma.providerRoutingRule.findUnique({
    where: { advisoryFirmId_providerNif: { advisoryFirmId: firmId, providerNif: nif } },
  });
  if (!rule || rule.ambiguous) return null;
  return rule.clientId;
}
