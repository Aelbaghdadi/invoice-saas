import { prisma } from "@/lib/prisma";
import { closurePeriodType } from "@/lib/closurePeriodType";
import type { ExportSelection } from "@/lib/exportPage";

type Closure = { clientId: string; month: number; year: number };

/**
 * A que exportacion lleva el «Exportar» de cada cierre (F-041). El cierre
 * solo guarda el mes: un T3 subido en trimestral se cierra con month=7, y
 * enlazarlo como mensual exportaba el trimestre con el nombre «2026-07» y lo
 * guardaba como julio. El tipo sale de las facturas de ese cliente, mes y
 * año (closurePeriodType, el mismo criterio que el resumen del cierre).
 */
export async function closureExportSelections(closures: Closure[], firmId: string): Promise<ExportSelection[]> {
  if (closures.length === 0) return [];
  const groups = await prisma.invoice.groupBy({
    by: ["clientId", "periodMonth", "periodYear", "periodType", "status"],
    where: {
      client: { advisoryFirmId: firmId },
      OR: closures.map((c) => ({ clientId: c.clientId, periodMonth: c.month, periodYear: c.year })),
    },
  });
  return closures.map((c) => {
    const invoices = groups.filter((g) => g.clientId === c.clientId && g.periodMonth === c.month && g.periodYear === c.year);
    return { clientId: c.clientId, periodType: closurePeriodType(c.month, invoices), month: c.month, year: c.year, type: "ALL" };
  });
}
