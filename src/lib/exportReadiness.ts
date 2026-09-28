import { prisma } from "@/lib/prisma";
import { partitionA3Exportable } from "@/lib/exportFormats";
import { withSplitCounts } from "@/lib/exportExclusions";

// Postgres admite 65.535 parametros por consulta: las ids van por tandas.
const CHUNK = 5000;

/**
 * De estas facturas (validadas y sin lote), cuales se llevaria la siguiente
 * exportacion y cuales se quedan fuera por algo que hay que corregir antes
 * (bloqueantes, F-025). Las que el Excel deja fuera para siempre (total 0,
 * originales divididas) no estan en ninguna de las dos. Es la misma decision
 * que la exportacion (partitionA3Exportable), para que «Exportar (N)» en
 * Lotes sea lo que se marca y no acabe en un 422.
 */
export async function exportReadiness(
  candidateIds: string[],
  firmId: string,
): Promise<{ exportable: Set<string>; blocked: Set<string> }> {
  const exportable = new Set<string>();
  const blocked = new Set<string>();
  for (let i = 0; i < candidateIds.length; i += CHUNK) {
    const ids = candidateIds.slice(i, i + CHUNK);
    const [rows, children] = await Promise.all([
      prisma.invoice.findMany({
        where: { id: { in: ids }, status: "VALIDATED", exportBatchId: null, client: { advisoryFirmId: firmId } },
        include: { client: true, vatLines: { orderBy: { position: "asc" } } },
      }),
      prisma.invoice.findMany({
        where: { splitFromId: { in: ids } },
        select: { splitFromId: true },
        distinct: ["splitFromId"],
      }),
    ]);
    const splitParents = new Set(children.map((c) => c.splitFromId).filter((id): id is string => id != null));
    const { exportable: ok, excluded } = partitionA3Exportable(withSplitCounts(rows, splitParents));
    for (const inv of ok) exportable.add(inv.id);
    for (const e of excluded) if (e.reason === "bloqueante") blocked.add(e.invoice.id);
  }
  return { exportable, blocked };
}
