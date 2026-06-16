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

function normalizeNif(nif: string | null | undefined): string {
  return parseTaxId(nif).clean.toUpperCase();
}

/** Aprende/actualiza la regla proveedor→empresa. No-op si no hay CIF de proveedor. */
export async function learnProviderRule(
  firmId: string,
  providerNif: string | null | undefined,
  clientId: string,
): Promise<void> {
  const nif = normalizeNif(providerNif);
  if (!nif) return;

  const existing = await prisma.providerRoutingRule.findUnique({
    where: { advisoryFirmId_providerNif: { advisoryFirmId: firmId, providerNif: nif } },
  });

  if (!existing) {
    await prisma.providerRoutingRule.create({
      data: { advisoryFirmId: firmId, providerNif: nif, clientId },
    });
    return;
  }
  if (existing.clientId === clientId) {
    // Confirmación: misma empresa otra vez -> sube confianza, des-marca ambiguo.
    await prisma.providerRoutingRule.update({
      where: { id: existing.id },
      data: { hitCount: { increment: 1 }, lastSeenAt: new Date(), ambiguous: false },
    });
  } else {
    // Mismo proveedor, empresa distinta -> ambiguo: deja de auto-rutear.
    await prisma.providerRoutingRule.update({
      where: { id: existing.id },
      data: { ambiguous: true, clientId, lastSeenAt: new Date() },
    });
  }
}

/** Empresa aprendida para un proveedor, o null si no hay regla o es ambigua. */
export async function lookupProviderClient(
  firmId: string,
  providerNif: string | null | undefined,
): Promise<string | null> {
  const nif = normalizeNif(providerNif);
  if (!nif) return null;
  const rule = await prisma.providerRoutingRule.findUnique({
    where: { advisoryFirmId_providerNif: { advisoryFirmId: firmId, providerNif: nif } },
  });
  if (!rule || rule.ambiguous) return null;
  return rule.clientId;
}
