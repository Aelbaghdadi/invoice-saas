import { z } from "zod";
import { yearMonthInMadrid } from "@/lib/dates";
import { quarterFromMonth, quarterStartMonth, type PeriodTypeName } from "@/lib/period";

/**
 * Lo que la pantalla de Exportar tiene elegido al abrirse (F-041): el cliente,
 * el periodo y el tipo. Sale de la URL (el botón «Exportar» de Lotes y de
 * Cierres) o, sin ella, del periodo anterior, que es el que se exporta.
 */
export type ExportSelection = {
  clientId: string;
  periodType: PeriodTypeName;
  /** En trimestral, el primer mes del trimestre (como lo pide la API). */
  month: number;
  year: number;
  type: "ALL" | "PURCHASE" | "SALE";
};

/** El mes o el trimestre anterior a hoy (en Madrid), con su año. */
export function previousPeriod(periodType: PeriodTypeName, now = new Date()): { month: number; year: number } {
  const { year, month } = yearMonthInMadrid(now);
  if (periodType === "QUARTERLY") {
    const quarter = quarterFromMonth(month);
    return quarter === 1 ? { month: 10, year: year - 1 } : { month: quarterStartMonth(quarter - 1), year };
  }
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

// Lo que no valga se ignora y queda el valor por defecto: es un enlace, no
// un formulario, y un parámetro viejo no tiene que dejar la pantalla vacía.
const pageParams = z.object({
  clientId: z.string().optional().catch(undefined),
  periodType: z.enum(["MONTHLY", "QUARTERLY"]).optional().catch(undefined),
  month: z.coerce.number().int().min(1).max(12).optional().catch(undefined),
  year: z.coerce.number().int().min(2000).max(2100).optional().catch(undefined),
  type: z.enum(["ALL", "PURCHASE", "SALE"]).optional().catch(undefined),
});

/**
 * La selección inicial a partir de la URL. El cliente solo si es de la lista
 * (los de la asesoría): un id de otra asesoría no se enseña ni se usa.
 * Mes y año van juntos: con uno solo, el periodo anterior.
 */
export function parseExportPageParams(
  params: Record<string, string | string[] | undefined>,
  clientIds: string[],
  now = new Date(),
): ExportSelection {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const p = pageParams.parse(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, first(v)])));
  const periodType = p.periodType ?? "MONTHLY";
  const period = p.month != null && p.year != null
    ? { month: periodType === "QUARTERLY" ? quarterStartMonth(quarterFromMonth(p.month)) : p.month, year: p.year }
    : previousPeriod(periodType, now);
  return {
    clientId: p.clientId && clientIds.includes(p.clientId) ? p.clientId : clientIds[0] ?? "",
    periodType,
    ...period,
    type: p.type ?? "ALL",
  };
}

/** Enlace a Exportar con esa selección. */
export function exportPageHref(selection: ExportSelection): string {
  const p = new URLSearchParams({
    clientId: selection.clientId,
    periodType: selection.periodType,
    month: String(selection.month),
    year: String(selection.year),
    type: selection.type,
  });
  return `/dashboard/admin/export?${p}`;
}
