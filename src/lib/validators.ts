/**
 * Validación de NIF/CIF/NIE español.
 *
 * Formatos:
 * - NIF personal: 8 dígitos + letra (12345678Z)
 * - NIE extranjero: X/Y/Z + 7 dígitos + letra (X1234567L)
 * - CIF empresa: letra + 7 dígitos + dígito/letra (B12345678)
 */

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

const CIF_PREFIXES = "ABCDEFGHJNPQRSUVW";

/** Validate a Spanish NIF (DNI + letter) */
function isValidDNI(nif: string): boolean {
  const match = nif.match(/^(\d{8})([A-Z])$/);
  if (!match) return false;
  const num = parseInt(match[1], 10);
  return match[2] === NIF_LETTERS[num % 23];
}

/** Validate a Spanish NIE (foreigners) */
function isValidNIE(nie: string): boolean {
  const match = nie.match(/^([XYZ])(\d{7})([A-Z])$/);
  if (!match) return false;
  const prefix = { X: "0", Y: "1", Z: "2" }[match[1]]!;
  const num = parseInt(prefix + match[2], 10);
  return match[3] === NIF_LETTERS[num % 23];
}

/** Validate a Spanish CIF (companies) */
function isValidCIF(cif: string): boolean {
  const match = cif.match(/^([A-W])(\d{7})([0-9A-J])$/);
  if (!match) return false;
  if (!CIF_PREFIXES.includes(match[1])) return false;

  const digits = match[2];
  let sumEven = 0;
  let sumOdd = 0;

  for (let i = 0; i < 7; i++) {
    const d = parseInt(digits[i], 10);
    if (i % 2 === 0) {
      // Odd positions (1-indexed): double and sum digits
      const doubled = d * 2;
      sumOdd += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sumEven += d;
    }
  }

  const total = sumEven + sumOdd;
  const control = (10 - (total % 10)) % 10;

  const checkChar = match[3];
  // Some CIF types use letter, others digit, some accept both
  const controlLetter = String.fromCharCode(64 + control); // A=1, B=2...
  return checkChar === String(control) || checkChar === controlLetter;
}

/**
 * Validate any Spanish tax ID (NIF, NIE, or CIF).
 * Returns true if the format and checksum are valid.
 */
export function isValidNIF(value: string): boolean {
  const cleaned = value.toUpperCase().replace(/[\s\-\.]/g, "");
  if (cleaned.length !== 9) return false;
  return isValidDNI(cleaned) || isValidNIE(cleaned) || isValidCIF(cleaned);
}

/** Clean and normalize a NIF/CIF/NIE: uppercase, remove spaces/dashes/dots */
export function formatNIF(value: string): string {
  return value.toUpperCase().replace(/[\s\-\.]/g, "");
}

// ─── Codigos VAT/pais para deteccion internacional ─────────────────────

/** Codigos VAT de los 27 estados miembros UE (2026). Grecia usa EL, no GR. */
const EU_VAT_PREFIXES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "EL", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

/** Codigos ISO 3166-1 alpha-2 que asumimos como prefijo VAT extra-UE
 *  (los mas comunes en facturacion B2B internacional). */
const NON_EU_COMMON = new Set([
  "GB", "CH", "NO", "US", "MX", "AR", "BR", "CL", "CO", "MA",
  "TR", "JP", "CN", "KR", "AU", "NZ", "CA", "IN", "SG",
]);

/** Resultado del parser de NIF/VAT: el numero limpio (sin prefijo y sin
 *  caracteres especiales) y el codigo de pais detectado (si lo hay). */
export type ParsedTaxId = {
  /** NIF/CIF normalizado y SIN prefijo de pais. Lo que guardamos en BD. */
  clean: string;
  /** Codigo ISO de pais si se detecto uno (ES, DE, FR...). null si no. */
  countryCode: string | null;
  /** "NATIONAL" si es ES o sin prefijo, "INTRACOM" si UE no-ES,
   *  "INTERNATIONAL" para resto. */
  scope: "NATIONAL" | "INTRACOM" | "INTERNATIONAL";
};

/**
 * Parsea un NIF/CIF/VAT que puede venir con prefijo de pais.
 *
 * Ejemplos:
 *   "B-12345678"         -> { clean: "B12345678", countryCode: null, scope: NATIONAL }
 *   "ES B12345678"       -> { clean: "B12345678", countryCode: "ES", scope: NATIONAL }
 *   "DE123456789"        -> { clean: "123456789", countryCode: "DE", scope: INTRACOM }
 *   "FR 12 345678901"    -> { clean: "12345678901", countryCode: "FR", scope: INTRACOM }
 *   "GB123456789"        -> { clean: "123456789", countryCode: "GB", scope: INTERNATIONAL }
 *
 * El "clean" es lo que se guarda en BD: nunca con prefijo de pais. El
 * pais se detecta por el prefijo o, si falta, queda null y asumimos
 * NATIONAL (caso de personas fisicas con DNI sin prefijo).
 */
export function parseTaxId(raw: string | null | undefined): ParsedTaxId {
  if (!raw) return { clean: "", countryCode: null, scope: "NATIONAL" };

  // Normalizar: mayusculas, sin espacios/guiones/puntos.
  const normalized = formatNIF(raw);

  // Detectar prefijo de pais: 2 letras al inicio que coincidan con la
  // tabla. Para evitar falsos positivos solo eliminamos prefijo si
  // queda al menos 5 caracteres alfanumericos despues.
  if (normalized.length >= 7) {
    const prefix = normalized.slice(0, 2);
    const rest   = normalized.slice(2);

    if (EU_VAT_PREFIXES.has(prefix)) {
      const scope = prefix === "ES" ? "NATIONAL" : "INTRACOM";
      return { clean: rest, countryCode: prefix, scope };
    }
    if (NON_EU_COMMON.has(prefix)) {
      return { clean: rest, countryCode: prefix, scope: "INTERNATIONAL" };
    }
  }

  // Sin prefijo identificable: asumimos nacional (DNI/CIF/NIE espanol).
  return { clean: normalized, countryCode: null, scope: "NATIONAL" };
}

/** Helper rapido: solo el "clean" (lo que va a BD). */
export function cleanTaxId(raw: string | null | undefined): string {
  return parseTaxId(raw).clean;
}

/** Helper rapido: el scope detectado a partir del NIF del emisor. */
export function detectScope(issuerCif: string | null | undefined): ParsedTaxId["scope"] {
  return parseTaxId(issuerCif).scope;
}
