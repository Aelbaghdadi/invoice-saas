/**
 * Moneda de los importes de una factura.
 *
 * A3 solo admite euros. Una factura en DKK o USD que entra con sus importes
 * tal cual es aritmeticamente coherente consigo misma, asi que ninguna
 * validacion matematica la detecta: por eso la moneda se guarda aparte y se
 * avisa en revision y en el export.
 */

/** Simbolos que no dejan dudas. "kr" o "$" a secas de otros paises no se
 *  pueden resolver: el "$" se da por dolar porque, sea cual sea, no es euro. */
const SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "$": "USD",
  "US$": "USD",
};

/** Lista cerrada a proposito: aceptar cualquier trio de letras convertiria
 *  "IVA" o "NIF" en una moneda extranjera y dispararia avisos falsos. */
const KNOWN_CODES = new Set([
  "EUR", "USD", "GBP", "CHF", "DKK", "SEK", "NOK", "ISK", "PLN", "CZK", "HUF",
  "RON", "BGN", "TRY", "RUB", "UAH", "JPY", "CNY", "HKD", "SGD", "KRW", "INR",
  "THB", "AUD", "NZD", "CAD", "MXN", "BRL", "ARS", "CLP", "COP", "PEN", "UYU",
  "MAD", "AED", "SAR", "ILS", "ZAR",
]);

/** Normaliza lo que devuelve el OCR a un codigo ISO 4217, o null si no se reconoce. */
export function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  if (!value) return null;
  if (SYMBOLS[value]) return SYMBOLS[value];
  return KNOWN_CODES.has(value) ? value : null;
}

/** ¿Van los importes en una moneda distinta del euro? Sin moneda detectada
 *  se asume euro, que es el caso de practicamente todas las facturas. */
export function isForeignCurrency(code: string | null | undefined): boolean {
  return code != null && code !== "" && code !== "EUR";
}
