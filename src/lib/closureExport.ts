import { prisma } from "@/lib/prisma";
import type { PeriodTypeName } from "@/lib/period";
import type { ExportSelection } from "@/lib/exportPage";

type Closure = { clientId: string; month: number; year: number };

const QUARTER_START_MONTHS = [1, 4, 7, 10];

/**
 * A que exportacion lleva el «Exportar» de cada cierre (F-041). El cierre
 * solo guarda el mes: un T3 subido en trimestral se cierra con month=7, y
 * enlazarlo como mensual exportaba el trimestre con el nombre «2026-07» y lo
 * guardaba como julio. El tipo sale de las facturas de ese cliente, mes y
 * año que cuentan: con alguna trimestral y un mes de inicio de trimestre,
 * trimestral.
 */
export async function closureExportSelections(closures: Closure[], firmId: string): Promise<ExportSelection[]> {
  if (closures.length === 0) return [];
  const groups = await prisma.invoice.groupBy({
    by: ["clientId", "periodMonth", "periodYear", "periodType"],
    where: {
      client: { advisoryFirmId: firmId },
      // Una trimestral rechazada (subida por error) no hace trimestral el
      // cierre de un cliente mensual; la original de una division tampoco.
      status: { notIn: ["REJECTED", "SPLIT_SOURCE"] },
      OR: closures.map((c) => ({ clientId: c.clientId, periodMonth: c.month, periodYear: c.year })),
    },
  });
  const quarterly = new Set(
    groups.filter((g) => g.periodType === "QUARTERLY").map((g) => `${g.clientId}|${g.periodMonth}|${g.periodYear}`),
  );
  return closures.map((c) => {
    const periodType: PeriodTypeName = QUARTER_START_MONTHS.includes(c.month) && quarterly.has(`${c.clientId}|${c.month}|${c.year}`)
      ? "QUARTERLY"
      : "MONTHLY";
    return { clientId: c.clientId, periodType, month: c.month, year: c.year, type: "ALL" };
  });
}
