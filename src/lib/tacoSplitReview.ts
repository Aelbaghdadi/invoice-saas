/**
 * El paso de revisión antes de dividir un taco entero (5.8): la lista de
 * rangos y los avisos de las marcas que suelen estar mal (una de menos o una de
 * más). Puro: lo usa la pantalla de las miniaturas, con los mismos rangos que
 * calcula el servidor (planTacoRanges).
 */
import { periodLabel, type PeriodTypeName } from "@/lib/period";
import type { TacoRange } from "@/lib/tacoSplitPlan";

/** Una factura con más páginas que esto se avisa: ¿falta una marca? */
export const TACO_LONG_INVOICE_PAGES = 10;
/** Con al menos tantas facturas, si más de la mitad son de una página se avisa: ¿sobra alguna marca? */
export const TACO_SINGLE_PAGE_MIN_INVOICES = 6;

/** «pág. 3» o «págs. 1-2». */
export function tacoPagesText(range: TacoRange): string {
  return range.start === range.end ? `pág. ${range.start}` : `págs. ${range.start}-${range.end}`;
}

/** Lo que se lee en la revisión: «Págs. 1-2 · sin factura» (si la primera marca no es la 1) y «Factura 1: págs. 3-4». */
export type TacoReviewItem = { kind: "skipped" | "invoice"; order: number | null; range: TacoRange; text: string };

export function tacoReviewItems(ranges: readonly TacoRange[]): TacoReviewItem[] {
  const items: TacoReviewItem[] = [];
  const first = ranges[0];
  if (first && first.start > 1) {
    const skipped = { start: 1, end: first.start - 1 };
    const pages = tacoPagesText(skipped);
    items.push({ kind: "skipped", order: null, range: skipped, text: `${pages[0].toUpperCase()}${pages.slice(1)} · sin factura` });
  }
  ranges.forEach((range, i) => {
    items.push({ kind: "invoice", order: i + 1, range, text: `Factura ${i + 1}: ${tacoPagesText(range)}` });
  });
  return items;
}

/**
 * Avisos de la revisión, solo los que tocan: una factura de más de 10 páginas
 * (seguramente falta una marca) y, con 6 o más facturas, más de la mitad de
 * una sola página (seguramente sobran marcas: con un escáner a dos caras, o
 * facturas de dos hojas).
 */
export function tacoSplitWarnings(ranges: readonly TacoRange[]): string[] {
  const warnings: string[] = [];
  ranges.forEach((range, i) => {
    const pages = range.end - range.start + 1;
    if (pages > TACO_LONG_INVOICE_PAGES) {
      warnings.push(`La factura ${i + 1} tiene ${pages} páginas: ¿seguro que es una sola?`);
    }
  });
  const singles = ranges.filter((range) => range.start === range.end).length;
  if (ranges.length >= TACO_SINGLE_PAGE_MIN_INVOICES && singles * 2 > ranges.length) {
    warnings.push(`${singles} facturas de una sola página: ¿seguro que no les falta una hoja?`);
  }
  return warnings;
}

const INVOICE_TYPE_LABELS: Record<string, string> = {
  PURCHASE: "Recibidas",
  SALE: "Emitidas",
  UNKNOWN: "tipo por detectar",
};

/** El lote de un taco como en Lotes: «Octubre 2026 · Recibidas» (con «Detectar automáticamente», «tipo por detectar»). */
export function tacoLotLabel(lot: {
  periodType: PeriodTypeName;
  periodMonth: number;
  periodYear: number;
  invoiceType: string;
}): string {
  const type = INVOICE_TYPE_LABELS[lot.invoiceType] ?? lot.invoiceType;
  return `${periodLabel(lot.periodType, lot.periodMonth, lot.periodYear)} · ${type}`;
}

/** «12 facturas» / «1 factura». */
export function invoiceCountText(count: number): string {
  return `${count} ${count === 1 ? "factura" : "facturas"}`;
}

/**
 * Lo que dice la barra de las marcas: cuántas facturas salen (una por marca,
 * aunque no valgan, para que 301 marcas no digan «0 facturas») y, si las
 * marcas no valen (más de 300, ninguna…), el porqué junto al botón apagado.
 */
export function tacoMarksBar(
  marks: readonly number[],
  plan: { ok: true; ranges: readonly TacoRange[] } | { ok: false; error: string },
): { invoiceCount: number; error: string | null } {
  if (plan.ok) return { invoiceCount: plan.ranges.length, error: null };
  return { invoiceCount: new Set(marks).size, error: plan.error };
}
