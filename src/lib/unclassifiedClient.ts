import { prisma } from "@/lib/prisma";

/**
 * Cliente técnico "Sin clasificar" de una asesoría: buzón que sostiene las
 * facturas subidas en modo clasificar mientras se rutean por CIF. cif/email
 * sintéticos y únicos por firma. Se excluye de selectores, listados, colas y
 * exportación (filtrando por isUnclassifiedBucket=false).
 *
 * Idempotente vía upsert por cif (único) para evitar duplicados ante subidas
 * concurrentes.
 */
export async function getOrCreateUnclassifiedClient(firmId: string): Promise<{ id: string }> {
  return prisma.client.upsert({
    where: { cif: `UNCLASSIFIED-${firmId}` },
    update: {},
    create: {
      name: "Sin clasificar",
      cif: `UNCLASSIFIED-${firmId}`,
      email: `sin-clasificar+${firmId}@facturocr.local`,
      advisoryFirmId: firmId,
      isUnclassifiedBucket: true,
    },
    select: { id: true },
  });
}
