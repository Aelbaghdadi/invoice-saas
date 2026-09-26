/**
 * Por que una factura VALIDATED se queda fuera del Excel de A3. Las
 * excluidas no se marcan como exportadas ni entran en el lote: siguen
 * pendientes hasta que se arreglen (F-009, F-015).
 *
 * Sin dependencias: lo usan el generador, la ruta de export y la pantalla.
 */
export type ExportExclusionReason = "total_cero" | "dividida";

export type ExportExclusionCounts = Record<ExportExclusionReason, number>;

/**
 *  - total_cero: A3 rechaza asientos de importe cero.
 *  - dividida: tiene facturas hijas (es la original de una division). Van
 *    las hijas; la original contabilizaria lo mismo otra vez. Normalmente es
 *    SPLIT_SOURCE y ni se lee, pero puede estar VALIDATED por datos antiguos.
 */
export function exportExclusionReason(inv: {
  totalAmount: unknown;
  _count?: { splitInvoices?: number };
}): ExportExclusionReason | null {
  if ((inv._count?.splitInvoices ?? 0) > 0) return "dividida";
  if (Math.abs(Number(inv.totalAmount ?? 0)) < 0.005) return "total_cero";
  return null;
}

export function countExportExclusions(reasons: ExportExclusionReason[]): ExportExclusionCounts {
  const counts: ExportExclusionCounts = { total_cero: 0, dividida: 0 };
  for (const r of reasons) counts[r] += 1;
  return counts;
}

/**
 * El desglose para los avisos: "2 con total 0 y 1 dividida en otras
 * facturas". null si no hay ninguna.
 */
export function describeExportExclusions(counts: Partial<ExportExclusionCounts>): string | null {
  const parts: string[] = [];
  const zero = counts.total_cero ?? 0;
  const split = counts.dividida ?? 0;
  if (zero > 0) parts.push(`${zero} con total 0`);
  if (split > 0) parts.push(`${split} ${split === 1 ? "dividida" : "divididas"} en otras facturas`);
  if (parts.length === 0) return null;
  return parts.join(" y ");
}

/**
 * Lee la cabecera X-Export-Excluded-Detail de la descarga. Un valor raro
 * (proxy que la recorta, version anterior del servidor) da {}: el aviso sale
 * sin desglose, pero sale.
 */
export function parseExportExclusionCounts(raw: string | null): Partial<ExportExclusionCounts> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const counts: Partial<ExportExclusionCounts> = {};
  for (const key of ["total_cero", "dividida"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) counts[key] = value;
  }
  return counts;
}
