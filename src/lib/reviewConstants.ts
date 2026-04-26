/**
 * Umbrales de confianza OCR usados en la UI de revision.
 *
 * - HIGH: se considera "campo seguro". No pide el foco del Tab.
 *   El valor se muestra en gris, sin badge grande; el gestor pasa por
 *   encima sin relerlo.
 * - REVIEW: por debajo de esto el campo se resalta en amarillo y recibe
 *   Tab automatico. Es el rango donde el OCR es "probable pero dudoso".
 * - CRITICAL: por debajo, el campo se marca en rojo. Probablemente
 *   falte o sea basura.
 *
 * Los valores estan calibrados a ojo sobre facturas espanolas con
 * Document AI Invoice Parser. Conviene revisarlos con una muestra real
 * una vez tengamos metricas.
 */
export const CONFIDENCE_HIGH = 0.92;
export const CONFIDENCE_REVIEW = 0.6;
export const CONFIDENCE_CRITICAL = 0.4;

/**
 * Umbral por encima del cual podriamos auto-validar una factura sin
 * intervencion humana (si ademas cumple otros criterios: plan de cuentas
 * cubierto, cuadre matematico, etc). NO se usa todavia — queda pendiente
 * de fase avanzada. Se centraliza aqui para evitar numeros magicos.
 */
export const CONFIDENCE_AUTO_VALIDATE = 0.97;

export type ConfidenceLevel = "high" | "review" | "critical" | "unknown";

/**
 * Clasifica un score de confianza en uno de los niveles anteriores.
 * `score = null | undefined` -> "unknown" (tratar como "review" en la UI).
 */
export function levelOf(score: number | null | undefined): ConfidenceLevel {
  if (score == null) return "unknown";
  if (score >= CONFIDENCE_HIGH) return "high";
  if (score >= CONFIDENCE_REVIEW) return "review";
  if (score >= CONFIDENCE_CRITICAL) return "critical";
  return "critical";
}

/** Devuelve true si el campo debe recibir foco automatico con Tab. */
export function shouldFocus(score: number | null | undefined): boolean {
  const lvl = levelOf(score);
  return lvl === "review" || lvl === "critical" || lvl === "unknown";
}
