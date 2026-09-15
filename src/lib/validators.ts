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
  | "INTRACOM_SERVICIOS"
  | "INVERSION_SP"
  | "IMPORTACION"
  | "IVA_NO_DEDUCIBLE";

/** Codigo numerico A3 para cada OperationType. Lo que va a la columna G
 *  del Excel A3 Asesor.
 *
 *  INTRACOM_SERVICIOS (8) es EXCLUSIVO de compras: en ventas ambas
 *  (bienes y servicios) comparten el codigo 3 — ver OPERATION_TYPE_OPTIONS
 *  y Invoice.intracomGoodsType para la distincion en expedidas (modelo 349). */
export const OPERATION_TYPE_CODE: Record<OperationTypeName, number> = {
  INTERIOR: 1,
  AGRARIA: 2,
  INTRACOM: 3,
  INVERSION_SP: 4,
  IMPORTACION: 6,
  IVA_NO_DEDUCIBLE: 7,
  INTRACOM_SERVICIOS: 8,
};

/** Etiquetas en español para facturas RECIBIDAS (compras). */
export const OPERATION_TYPE_LABEL: Record<OperationTypeName, string> = {
  INTERIOR: "Interior (IVA deducible)",
  AGRARIA: "Compensaciones Agrarias",
  INTRACOM: "Adquisición Intracomunitaria de Bienes",
  INTRACOM_SERVICIOS: "Adquisición Intracomunitaria de Servicios",
  INVERSION_SP: "Inversión del Sujeto Pasivo",
  IMPORTACION: "Importación (fuera UE)",
  IVA_NO_DEDUCIBLE: "IVA no deducible",
};

/** Etiquetas para facturas EMITIDAS (ventas). Mismos valores del enum,
 *  pero en una expedida el significado cambia: el 3 de A3 es una ENTREGA
 *  intracomunitaria (bienes o servicios, ver intracomGoodsType) y el 6 una
 *  exportacion (lista real de A3 eco). Los valores que solo tienen sentido
 *  en compras se marcan como tales por si una factura antigua los trae
 *  guardados. */
export const OPERATION_TYPE_LABEL_SALE: Record<OperationTypeName, string> = {
  INTERIOR: "Interior (sujeta a IVA)",
  AGRARIA: "Compensaciones Agrarias (solo compras)",
  INTRACOM: "Entrega Intracomunitaria",
  INTRACOM_SERVICIOS: "Adquisición Intracomunitaria de Servicios (solo compras)",
  INVERSION_SP: "Inversión del Sujeto Pasivo (solo compras)",
  IMPORTACION: "Exportación (fuera UE)",
  IVA_NO_DEDUCIBLE: "IVA no deducible (solo compras)",
};

/** Clasificación BIENES/SERVICIOS de una intracomunitaria. En compras decide
 *  el código de operación (3 bienes / 8 servicios); en ventas el código es
 *  siempre 3 y decide la cuenta de ingreso (700 / 705). Ver src/lib/intracomGoods.ts. */
export type IntracomGoodsTypeName = "BIENES" | "SERVICIOS";

export const INTRACOM_GOODS_TYPE_LABEL: Record<IntracomGoodsTypeName, string> = {
  BIENES: "Bienes",
  SERVICIOS: "Servicios",
};

/** Etiqueta segun el sentido de la factura. */
export function operationTypeLabel(
  op: OperationTypeName,
  invoiceType: "PURCHASE" | "SALE",
): string {
  return invoiceType === "SALE" ? OPERATION_TYPE_LABEL_SALE[op] : OPERATION_TYPE_LABEL[op];
}

/** Valores ofrecidos en el desplegable de tipo de operacion segun el
 *  sentido. En ventas solo los tres cuyo codigo exportado (columna G)
 *  coincide con la lista real de expedidas de A3: 1 interior, 3 entrega
 *  intracomunitaria, 6 exportacion. INVERSION_SP se excluye a proposito:
 *  con el mapa unico actual exportaria un 4, que en expedidas significa
 *  "operacion triangular". Bifurcar OPERATION_TYPE_CODE por sentido esta
 *  pendiente de confirmar los codigos reales con el asesor.
 *
 *  INTRACOM_SERVICIOS tambien se excluye de ventas a proposito: en
 *  expedidas bienes y servicios comparten el codigo 3 (ver
 *  Invoice.intracomGoodsType para la Clave 349), asi que ofrecer el 8
 *  llevaria a exportar un codigo que en expedidas no existe. */
export const OPERATION_TYPE_OPTIONS: Record<"PURCHASE" | "SALE", OperationTypeName[]> = {
  PURCHASE: ["INTERIOR", "AGRARIA", "INTRACOM", "INTRACOM_SERVICIOS", "INVERSION_SP", "IMPORTACION", "IVA_NO_DEDUCIBLE"],
  SALE: ["INTERIOR", "INTRACOM", "IMPORTACION"],
};

// ─── Recargo de Equivalencia ─────────────────────────────────────────────

/** Mapeo IVA -> % recargo de equivalencia habitual. Solo se aplica cuando
 *  ya sabemos con certeza (Client.equivalenceSurchargeCustomer) que la
 *  factura esta sujeta a RE — nunca por el simple hecho de que el IVA sea
 *  uno de estos tres valores. */
const EQUIVALENCE_SURCHARGE_BY_VAT: Record<number, number> = {
  21: 5.2,
  10: 1.4,
  4: 0.5,
};

/** % de recargo de equivalencia habitual para un tipo de IVA, o null si el
 *  tipo no tiene un recargo estandar asociado (el gestor lo introduce a mano). */
export function equivalenceSurchargeRateForVat(vatRate: number): number | null {
  return EQUIVALENCE_SURCHARGE_BY_VAT[vatRate] ?? null;
}

// ─── Normalización de nombres de terceros ───────────────────────────────

/** Normaliza un nombre de tercero (proveedor/cliente) para comparar de
 *  forma insensible a mayusculas, tildes, puntuacion y espacios. Ej:
 *  "Bar Pepe, S.L." y "BAR PEPE S L" normalizan igual. Compartido por el
 *  auto-ruteo multicliente (invoiceRouting.ts) y el matching del plan de
 *  cuentas por nombre cuando el NIF no es fiable (supplierMatching.ts). */
export function normalizeBusinessName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

/**
 * Valida un NIF/VAT tal y como lo ve el gestor en el formulario, con o
 * sin prefijo de pais. Nacional (ES o sin prefijo) -> algoritmo español
 * completo. Extranjero -> solo formato plausible tras el prefijo: la
 * letra de control de cada pais no es verificable sin consultar VIES.
 */
export function isValidTaxIdWithPrefix(raw: string): boolean {
  const parsed = parseTaxId(raw);
  if (!parsed.clean) return false;
  if (!parsed.countryCode || parsed.countryCode === "ES") return isValidNIF(parsed.clean);
  return /^[0-9A-Z]{2,12}$/.test(parsed.clean);
}

// ─── Retenciones IRPF ──────────────────────────────────────────────────

export type RetentionTypeName = "PROFESSIONAL" | "RENT";

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
/**
 * ¿El texto del documento menciona una retencion IRPF?
 *
 * Necesario porque no todas las rutas de OCR extraen el IRPF: Document AI
 * devuelve siempre irpfRate/irpfAmount a null, asi que sin mirar el texto
 * la retencion no se sugeriria jamas en ese modo. Se busca en la capa de
 * orquestacion (processInvoice), no en ocr.ts.
 */
export function textMentionsRetention(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // "sin retencion", "no sujeta a retencion", "exento de retencion": son
    // justo el caso CONTRARIO, asi que se borran antes de buscar.
    .replace(/\b(sin|no\s+sujet\w*\s+a|exent\w*\s+de)\s+retenc\w*/g, " ");
  return /\birpf\b/.test(t)
    || /\bretenc(?:ion|iones)\b/.test(t)
    || /\bretenid[oa]s?\b/.test(t);
}

export function isPersonaFisica(rawCif: string | null | undefined): boolean {
  if (!rawCif) return false;
  const cif = formatNIF(rawCif);
  if (cif.length !== 9) return false;
  return /^\d{8}[A-Z]$/.test(cif) || /^[XYZ]\d{7}[A-Z]$/.test(cif);
}
