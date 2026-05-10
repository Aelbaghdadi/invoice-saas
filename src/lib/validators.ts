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

/** Tipo de operacion fiscal segun el enum Prisma `OperationType`. */
export type OperationTypeName =
  | "INTERIOR"
  | "AGRARIA"
  | "INTRACOM"
  | "INVERSION_SP"
  | "IMPORTACION"
  | "IVA_NO_DEDUCIBLE";

/** Codigo numerico A3 para cada OperationType. Lo que va a la columna G
 *  del Excel A3 Asesor. */
export const OPERATION_TYPE_CODE: Record<OperationTypeName, number> = {
  INTERIOR: 1,
  AGRARIA: 2,
  INTRACOM: 3,
  INVERSION_SP: 4,
  IMPORTACION: 6,
  IVA_NO_DEDUCIBLE: 7,
};

/** Etiquetas en español para mostrar en la UI. */
export const OPERATION_TYPE_LABEL: Record<OperationTypeName, string> = {
  INTERIOR: "Interior (IVA deducible)",
  AGRARIA: "Compensaciones Agrarias",
  INTRACOM: "Adquisición Intracomunitaria",
  INVERSION_SP: "Inversión del Sujeto Pasivo",
  IMPORTACION: "Importación (fuera UE)",
  IVA_NO_DEDUCIBLE: "IVA no deducible",
};

/** Resultado del parser de NIF/VAT: el numero limpio (sin prefijo y sin
 *  caracteres especiales), el codigo de pais detectado y el tipo de
 *  operación inferido por defecto a partir del prefijo. */
export type ParsedTaxId = {
  /** NIF/CIF normalizado y SIN prefijo de pais. Lo que guardamos en BD. */
  clean: string;
  /** Codigo ISO de pais si se detecto uno (ES, DE, FR...). null si no. */
  countryCode: string | null;
  /** Tipo de operacion FISCAL inferido del prefijo del NIF.
   *  Solo es la suposicion inicial — el gestor puede cambiarlo (p.ej.
   *  marcar Inversion SP en una factura nacional de construccion). */
  operationType: OperationTypeName;
};

/**
 * Parsea un NIF/CIF/VAT que puede venir con prefijo de pais.
 *
 * Ejemplos:
 *   "B-12345678"         -> { clean: "B12345678", countryCode: null, operationType: INTERIOR }
 *   "ES B12345678"       -> { clean: "B12345678", countryCode: "ES", operationType: INTERIOR }
 *   "DE123456789"        -> { clean: "123456789", countryCode: "DE", operationType: INTRACOM }
 *   "FR 12 345678901"    -> { clean: "12345678901", countryCode: "FR", operationType: INTRACOM }
 *   "GB123456789"        -> { clean: "123456789", countryCode: "GB", operationType: IMPORTACION }
 *
 * El "clean" es lo que se guarda en BD: nunca con prefijo de pais.
 * Reglas de operationType por defecto:
 *   - ES o sin prefijo  -> INTERIOR
 *   - UE no-ES          -> INTRACOM
 *   - No-UE             -> IMPORTACION
 *   - AGRARIA / INVERSION_SP / IVA_NO_DEDUCIBLE: nunca por defecto, los
 *     pone el gestor o se aprenden de AccountEntry.defaultOperationType.
 */
export function parseTaxId(raw: string | null | undefined): ParsedTaxId {
  if (!raw) return { clean: "", countryCode: null, operationType: "INTERIOR" };

  // Normalizar: mayusculas, sin espacios/guiones/puntos.
  const normalized = formatNIF(raw);

  // Detectar prefijo de pais: 2 letras al inicio que coincidan con la
  // tabla. Para evitar falsos positivos solo eliminamos prefijo si
  // queda al menos 5 caracteres alfanumericos despues.
  if (normalized.length >= 7) {
    const prefix = normalized.slice(0, 2);
    const rest   = normalized.slice(2);

    if (EU_VAT_PREFIXES.has(prefix)) {
      const operationType: OperationTypeName = prefix === "ES" ? "INTERIOR" : "INTRACOM";
      return { clean: rest, countryCode: prefix, operationType };
    }
    if (NON_EU_COMMON.has(prefix)) {
      return { clean: rest, countryCode: prefix, operationType: "IMPORTACION" };
    }
  }

  // Sin prefijo identificable: asumimos nacional (DNI/CIF/NIE espanol).
  return { clean: normalized, countryCode: null, operationType: "INTERIOR" };
}

/** Helper rapido: solo el "clean" (lo que va a BD). */
export function cleanTaxId(raw: string | null | undefined): string {
  return parseTaxId(raw).clean;
}

/** Helper rapido: el operationType detectado a partir del NIF del emisor. */
export function detectOperationType(issuerCif: string | null | undefined): OperationTypeName {
  return parseTaxId(issuerCif).operationType;
}

// ─── Retenciones IRPF ──────────────────────────────────────────────────

export type RetentionTypeName = "PROFESSIONAL" | "RENT";

/** Codigo numerico para A3 (Modelo 111 vs 115). */
export const RETENTION_TYPE_CODE: Record<RetentionTypeName, number> = {
  PROFESSIONAL: 1,  // Modelo 111 — actividades profesionales
  RENT:         2,  // Modelo 115 — arrendamientos urbanos
};

/** Etiquetas para UI. */
export const RETENTION_TYPE_LABEL: Record<RetentionTypeName, string> = {
  PROFESSIONAL: "Profesional (Modelo 111)",
  RENT:         "Arrendamiento (Modelo 115)",
};

/** % por defecto cuando se detecta el tipo. PROFESSIONAL puede ser 7%
 *  para nuevos autonomos pero el caso comun es 15% — el gestor lo
 *  ajusta a mano si es 7%. */
export const RETENTION_DEFAULT_RATE: Record<RetentionTypeName, number> = {
  PROFESSIONAL: 15,
  RENT:         19,
};

/**
 * Detecta si un NIF/CIF corresponde a una persona fisica (DNI o NIE),
 * lo que sugiere fuertemente que la factura es de un profesional
 * autonomo y por tanto suele llevar retencion IRPF (Modelo 111).
 *
 * Reglas:
 *  - DNI: 8 digitos + letra (ej. 12345678Z)
 *  - NIE: empieza por X/Y/Z + 7 digitos + letra (ej. X1234567L)
 *  - CIF (empresas) empieza por A/B/C/D/E/F/G/H/J/N/P/Q/R/S/U/V/W -> NO persona fisica
 */
export function isPersonaFisica(rawCif: string | null | undefined): boolean {
  if (!rawCif) return false;
  const cif = formatNIF(rawCif);
  if (cif.length !== 9) return false;
  return /^\d{8}[A-Z]$/.test(cif) || /^[XYZ]\d{7}[A-Z]$/.test(cif);
}
