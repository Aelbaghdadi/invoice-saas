/**
 * Codigo del catalogo y mensaje para el gestor cuando falla el procesado de
 * una factura. Se guarda en lastOcrError como "[ERR-XXX-NNN] mensaje".
 *
 * Sin dependencias de Prisma ni de Next: se reconoce el error de Prisma por su
 * forma (code P2xxx o el nombre de la clase), no con instanceof.
 */
export type OcrErrorCode = "ERR-OCR-001" | "ERR-OCR-002" | "ERR-OCR-003" | "ERR-OCR-004" | "ERR-SYS-001";

/**
 * Un error de la base de datos (una FK que falla al guardar la auditoria,
 * una transaccion caducada...) no dice nada del documento. Antes su mensaje
 * ("Invalid `prisma.auditLog.create()` invocation") caia en ERR-OCR-002 y el
 * gestor veia su factura como ilegible.
 */
export function isDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, name } = err as { code?: unknown; name?: unknown };
  if (typeof code === "string" && /^P\d{4}$/.test(code)) return true;
  return typeof name === "string" && name.startsWith("PrismaClient");
}

/** Heuristica simple: no necesita ser perfecta, solo ayudar al soporte a
 *  triagear sin tener que abrir logs. */
export function classifyOcrError(err: unknown): OcrErrorCode {
  if (isDatabaseError(err)) return "ERR-SYS-001";
  const lower = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "ERR-OCR-003";
  if (lower.includes("download") || lower.includes("storage") || lower.includes("404")) return "ERR-OCR-004";
  if (lower.includes("invalid") || lower.includes("corrupt") || lower.includes("malformed")) return "ERR-OCR-002";
  return "ERR-OCR-001";
}

/** Mensaje en español, apto para el gestor. El stack técnico nunca se
 *  muestra en la UI (va al log). */
export function userMessageForOcrError(code: OcrErrorCode): string {
  switch (code) {
    case "ERR-SYS-001": return "Error interno al guardar el análisis. Vuelve a procesarla; si se repite, avisa a soporte.";
    case "ERR-OCR-003": return "El análisis tardó demasiado. Vuelve a procesarla.";
    case "ERR-OCR-004": return "No se pudo descargar el archivo. Vuelve a procesarla.";
    case "ERR-OCR-002": return "No se pudieron leer los datos del documento (ilegible o con formato no válido). Revísala manualmente.";
    default:            return "No se pudo procesar la factura. Vuelve a intentarlo o revísala manualmente.";
  }
}
