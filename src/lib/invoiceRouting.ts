/**
 * Auto-ruteo de facturas a varios clientes por CIF.
 *
 * Caso de uso: un gestor sube un montón mezclado de facturas que pertenecen a
 * varias empresas (clientes) del mismo grupo. Como el tipo (compra/venta) se
 * elige al subir, sabemos de qué lado está el cliente: en COMPRAS (PURCHASE) el
 * cliente es el RECEPTOR; en VENTAS (SALE) el cliente es el EMISOR. Comparamos
 * ese CIF contra los CIF de los clientes candidatos del lote y decidimos a cuál
 * pertenece la factura, o la dejamos "Por clasificar" si no hay match claro.
 *
 * Módulo PURO (sin Prisma ni OCR): testeable de forma aislada. La orquestación
 * (descargar el OCR, reasignar el cliente, persistir) vive en processInvoice.
 */
import { parseTaxId, isValidNIF } from "@/lib/validators";

export type RoutingCandidate = { clientId: string; cif: string };

export type RoutingReason = "no_cif" | "invalid_cif" | "no_match" | "ambiguous";

export type RoutingResult =
  | { status: "routed"; clientId: string }
  | {
      status: "unclassified";
      /** Por qué no se pudo rutear automáticamente. */
      reason: RoutingReason;
    };

/** Normaliza un CIF para comparar: quita prefijo de país (ES), separadores y
 *  pasa a mayúsculas. Misma normalización que usa el resto del sistema, así
 *  "ESB12345674", "B-12345674" y "b12345674" se comparan iguales. */
function normalizeCif(raw: string | null | undefined): string {
  return parseTaxId(raw).clean.toUpperCase();
}

/** Devuelve el CIF del lado del cliente según el tipo de factura:
 *  COMPRA -> receptor, VENTA -> emisor. */
export function clientSideCif(
  type: "PURCHASE" | "SALE",
  extracted: { issuerCif: string | null | undefined; receiverCif: string | null | undefined },
): string | null {
  const cif = type === "PURCHASE" ? extracted.receiverCif : extracted.issuerCif;
  return cif ?? null;
}

/**
 * Decide a qué cliente candidato pertenece una factura comparando el CIF del
 * lado del cliente contra los CIF de los candidatos.
 *
 *  - sin CIF legible            -> unclassified("no_cif")
 *  - casa con EXACTAMENTE 1     -> routed(clientId)
 *  - casa con >1 (CIF de varios candidatos colisionan al normalizar) ->
 *                                  unclassified("ambiguous") (error de alta;
 *                                  no desempatamos a ciegas)
 *  - no casa con ninguno        -> unclassified("no_match")
 */
export function routeByCif(
  candidates: RoutingCandidate[],
  clientCif: string | null | undefined,
  otherCif?: string | null | undefined,
): RoutingResult {
  const target = normalizeCif(clientCif);
  if (!target) return { status: "unclassified", reason: "no_cif" };
  // Si el CIF del lado del cliente no pasa el dígito de control, casi seguro
  // es un error de OCR: no arriesgamos un ruteo silencioso a otra empresa.
  if (!isValidNIF(target)) return { status: "unclassified", reason: "invalid_cif" };

  const matches = candidates.filter((c) => normalizeCif(c.cif) === target);
  if (matches.length > 1) return { status: "unclassified", reason: "ambiguous" };
  if (matches.length === 0) return { status: "unclassified", reason: "no_match" };

  // Intra-grupo / tipo invertido: si el OTRO lado también es un candidato
  // (p.ej. una empresa del grupo factura a otra del grupo, o el OCR confundió
  // emisor/receptor), no desempatamos a ciegas — a clasificación manual para
  // que el gestor confirme tipo/empresa y cree la contrapartida si procede.
  const other = normalizeCif(otherCif);
  if (other && candidates.some((c) => normalizeCif(c.cif) === other)) {
    return { status: "unclassified", reason: "ambiguous" };
  }

  return { status: "routed", clientId: matches[0].clientId };
}

export type TextRoutingCandidate = { clientId: string; cif: string; name: string };

/** Normaliza un nombre para comparar contra el texto del OCR: sin tildes,
 *  en mayúsculas y sin puntuación (espacios colapsados). Así "Bar Pepe, S.L."
 *  del alta casa con "BAR PEPE S L" que pueda leer el OCR. */
function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar tildes/diacriticos
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fallback de ruteo por el TEXTO CRUDO del OCR, para cuando la extracción
 * estructurada no logró casar el CIF (Document AI a veces no rellena el campo
 * aunque el dato esté claramente en el documento). Busca, en cascada:
 *   1) el CIF (normalizado y con dígito de control válido) de un candidato;
 *   2) si no, el nombre del candidato.
 * Solo rutea si EXACTAMENTE un candidato casa; si casan varios (p.ej. factura
 * intragrupo donde aparecen dos empresas) devuelve null y se queda manual.
 */
export function routeByText(
  rawText: string | null | undefined,
  candidates: TextRoutingCandidate[],
): { clientId: string; via: "cif" | "name" } | null {
  if (!rawText || candidates.length === 0) return null;

  // Texto compacto (sin separadores) para encontrar el CIF aunque el OCR lo
  // escriba como "B-12345674" o "ES B12345674".
  const compact = rawText.toUpperCase().replace(/[\s.\-/]/g, "");
  const byCif = candidates.filter((c) => {
    const cif = normalizeCif(c.cif);
    return cif.length >= 8 && isValidNIF(cif) && compact.includes(cif);
  });
  if (byCif.length === 1) return { clientId: byCif[0].clientId, via: "cif" };
  if (byCif.length > 1) return null; // varios CIF de candidatos en el texto → ambiguo

  // Texto normalizado (sin tildes ni puntuación) para buscar el nombre.
  const normText = normalizeName(rawText);
  const byName = candidates.filter((c) => {
    const name = normalizeName(c.name);
    return name.length >= 4 && normText.includes(name);
  });
  if (byName.length === 1) return { clientId: byName[0].clientId, via: "name" };
  return null;
}

/**
 * Detecta el tipo (compra/venta) de una factura "sin determinar" por el lado
 * donde aparece el CIF del cliente: si el cliente es el RECEPTOR -> compra
 * (recibida); si es el EMISOR -> venta (emitida). Devuelve null si el CIF del
 * cliente no casa con exactamente un lado (OCR ilegible, o aparece en ambos).
 */
export function detectInvoiceType(
  clientCif: string | null | undefined,
  extracted: { issuerCif: string | null | undefined; receiverCif: string | null | undefined },
): "PURCHASE" | "SALE" | null {
  const c = normalizeCif(clientCif);
  if (!c) return null;
  const isReceiver = normalizeCif(extracted.receiverCif) === c;
  const isIssuer = normalizeCif(extracted.issuerCif) === c;
  if (isReceiver && !isIssuer) return "PURCHASE";
  if (isIssuer && !isReceiver) return "SALE";
  return null;
}
