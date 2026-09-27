/**
 * Por que una factura VALIDATED se queda fuera del Excel de A3. Las
 * excluidas no se marcan como exportadas ni entran en el lote: siguen
 * pendientes hasta que se arreglen (F-009, F-015).
 *
 * Sin dependencias: lo usan el generador, la ruta de export y la pantalla.
 */
export type ExportExclusionReason = "total_cero" | "dividida" | "bloqueante";

const REASONS: ExportExclusionReason[] = ["total_cero", "dividida", "bloqueante"];

export type ExportExclusionCounts = Record<ExportExclusionReason, number>;

/**
 *  - total_cero: A3 rechaza asientos de importe cero.
 *  - dividida: tiene facturas hijas (es la original de una division). Van
 *    las hijas; la original contabilizaria lo mismo otra vez. Normalmente es
 *    SPLIT_SOURCE y ni se lee, pero puede estar VALIDATED por datos antiguos.
 *
 * La tercera, bloqueante (le faltan datos o esta en otra moneda, F-025), la
 * decide a3ExclusionReason en exportFormats: necesita la factura entera.
 */
export function exportExclusionReason(inv: {
  totalAmount: unknown;
  _count?: { splitInvoices?: number };
}): ExportExclusionReason | null {
  if ((inv._count?.splitInvoices ?? 0) > 0) return "dividida";
  // Un total vacio no es un total 0: es un dato que falta (bloqueante,
  // sin_total), y salian los dos textos a la vez.
  if (inv.totalAmount == null) return null;
  if (Math.abs(Number(inv.totalAmount)) < 0.005) return "total_cero";
  return null;
}

/**
 * Pone a cada factura el _count.splitInvoices que espera
 * exportExclusionReason a partir de las ids que tienen hijas. El export las
 * saca con una segunda consulta acotada a las candidatas: el _count de Prisma
 * agregaba la tabla Invoice entera (LEFT JOIN de un GROUP BY sin filtro) en
 * cada vista previa.
 */
export function withSplitCounts<T extends { id: string }>(
  invoices: T[],
  splitParentIds: ReadonlySet<string>,
): (T & { _count: { splitInvoices: number } })[] {
  return invoices.map((inv) => ({ ...inv, _count: { splitInvoices: splitParentIds.has(inv.id) ? 1 : 0 } }));
}

export function countExportExclusions(reasons: ExportExclusionReason[]): ExportExclusionCounts {
  const counts: ExportExclusionCounts = { total_cero: 0, dividida: 0, bloqueante: 0 };
  for (const r of reasons) counts[r] += 1;
  return counts;
}

/**
 * El desglose para los avisos: "2 con total 0, 1 dividida en otras facturas
 * y 3 con errores que impiden exportarlas". null si no hay ninguna.
 */
export function describeExportExclusions(counts: Partial<ExportExclusionCounts>): string | null {
  const parts: string[] = [];
  const zero = counts.total_cero ?? 0;
  const split = counts.dividida ?? 0;
  const blocked = counts.bloqueante ?? 0;
  if (zero > 0) parts.push(`${zero} con total 0`);
  if (split > 0) parts.push(`${split} ${split === 1 ? "dividida" : "divididas"} en otras facturas`);
  if (blocked > 0) parts.push(`${blocked} con errores que impiden ${blocked === 1 ? "exportarla" : "exportarlas"}`);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}` : parts[0];
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
  for (const key of REASONS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) counts[key] = value;
  }
  return counts;
}

/**
 * En que caja de la vista previa va una excluida: «corregir» (roja: sigue
 * pendiente hasta que se corrija) o «fuera» (gris: no va a A3 y no hay nada
 * que corregir). El resumen se da por caja: por motivo mezclaba las dos
 * (revision 2 del PR #7).
 */
export type ExportExclusionBox = "corregir" | "fuera";

export type ExportExclusionBoxCounts = Record<ExportExclusionBox, number>;

export function countExportExclusionBoxes(boxes: ExportExclusionBox[]): ExportExclusionBoxCounts {
  const counts: ExportExclusionBoxCounts = { corregir: 0, fuera: 0 };
  for (const b of boxes) counts[b] += 1;
  return counts;
}

/** "2 que hay que corregir y 1 que no va a A3", o null si no hay ninguna. */
export function describeExportExclusionBoxes(counts: Partial<ExportExclusionBoxCounts>): string | null {
  const parts: string[] = [];
  const fix = counts.corregir ?? 0;
  const out = counts.fuera ?? 0;
  if (fix > 0) parts.push(`${fix} que hay que corregir`);
  if (out > 0) parts.push(`${out} que no ${out === 1 ? "va" : "van"} a A3`);
  return parts.length ? parts.join(" y ") : null;
}

/** Cabecera X-Export-Excluded-Boxes de la descarga; {} si no se entiende. */
export function parseExportExclusionBoxes(raw: string | null): Partial<ExportExclusionBoxCounts> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const counts: Partial<ExportExclusionBoxCounts> = {};
  for (const key of ["corregir", "fuera"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) counts[key] = value;
  }
  return counts;
}

/** Lo que se quedo fuera tras descargar, por caja: solo las que hay que
 *  corregir «siguen pendientes»; las que no van a A3 no tienen nada
 *  pendiente. Sin la cabecera por caja (version anterior del servidor), el
 *  total a secas. Empieza por un espacio: va detras de otra frase. */
export function exportSuccessExclusionText(success: { excluded: number; boxes: Partial<ExportExclusionBoxCounts> }): string {
  if (success.excluded <= 0) return "";
  const fix = success.boxes.corregir ?? 0;
  const out = success.boxes.fuera ?? 0;
  if (fix + out === 0) {
    return success.excluded === 1
      ? " 1 factura se ha quedado fuera del Excel."
      : ` ${success.excluded} facturas se han quedado fuera del Excel.`;
  }
  const parts: string[] = [];
  if (fix > 0) {
    parts.push(fix === 1
      ? " 1 factura se ha quedado fuera y sigue pendiente hasta que la corrijas."
      : ` ${fix} facturas se han quedado fuera y siguen pendientes hasta que las corrijas.`);
  }
  if (out > 0) {
    parts.push(out === 1
      ? " 1 factura se ha quedado fuera del Excel: no va a A3 y no hay nada que hacer con ella."
      : ` ${out} facturas se han quedado fuera del Excel: no van a A3 y no hay nada que hacer con ellas.`);
  }
  return parts.join("");
}
