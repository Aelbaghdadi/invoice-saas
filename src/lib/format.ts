/**
 * Formato de importes para la UI, en español: "1.234,50 €".
 *
 * Una sola forma para toda la app. Antes cada pantalla ponia la suya:
 * "€1234.5" en la ficha, "1234.50 €" al clasificar, "0.01€" en las
 * incidencias y "1.234,50 €" en las listas.
 */

const NUMERO = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Importe sin simbolo: "1.234,50". Para celdas donde el € ya va aparte. */
export function formatAmountEs(value: number | string | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? NUMERO.format(n) : "—";
}

/** Importe con simbolo: "1.234,50 €". "—" si no hay importe. */
export function formatEur(value: number | string | null | undefined): string {
  const s = formatAmountEs(value);
  return s === "—" ? s : `${s} €`;
}
