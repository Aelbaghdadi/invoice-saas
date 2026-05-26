/**
 * Catálogo centralizado de códigos de error de FacturOCR.
 *
 * Cada error que se muestra al usuario lleva asociado un código corto
 * (ERR-XXX-NNN) que el gestor puede copiar al soporte. El backend logea
 * el código + detalles tecnicos; el frontend muestra solo el mensaje
 * amable + el código pequeño, con boton "copiar detalles".
 *
 * Convención de nomenclatura:
 *   ERR-<DOMINIO>-<NNN>
 *   - DOMINIO: UPLOAD, OCR, VALIDATE, EXPORT, AUTH, SYS, ...
 *   - NNN: numero secuencial dentro del dominio (001, 002, ...).
 *
 * Al añadir un código nuevo:
 *   1. Añadir la entrada en AppErrorCode (mantener orden por dominio).
 *   2. Añadir el mensaje user-facing en ERROR_MESSAGES.
 *   3. Usar `appError("ERR-XXX-NNN", details?)` en el código.
 */

export type AppErrorCode =
  // ── Upload ───────────────────────────────────────────────
  | "ERR-UPLOAD-001"  // Tamaño máximo excedido
  | "ERR-UPLOAD-002"  // Tipo de archivo no permitido (magic-bytes mismatch)
  | "ERR-UPLOAD-003"  // Fallo al subir a Storage
  | "ERR-UPLOAD-004"  // Periodo cerrado (no se pueden anadir facturas)
  | "ERR-UPLOAD-005"  // Sin acceso al cliente seleccionado
  | "ERR-UPLOAD-006"  // Duplicado (mismo hash en una factura activa)
  | "ERR-UPLOAD-007"  // Nombre de archivo inválido
  // ── OCR ──────────────────────────────────────────────────
  | "ERR-OCR-001"     // Document AI no disponible / fallo de red
  | "ERR-OCR-002"     // PDF/imagen corrupto o no procesable
  | "ERR-OCR-003"     // Timeout del procesado (>60s)
  | "ERR-OCR-004"     // Storage download fallo (archivo borrado en Storage)
  // ── Validación ───────────────────────────────────────────
  | "ERR-VALIDATE-001"  // CIF emisor coincide con CIF receptor
  | "ERR-VALIDATE-002"  // Periodo contable cerrado
  | "ERR-VALIDATE-003"  // Factura modificada por otro usuario (optimistic lock)
  | "ERR-VALIDATE-004"  // Linea de IVA invalida (rango, negativos no permitidos...)
  // ── Export ───────────────────────────────────────────────
  | "ERR-EXPORT-001"  // Sin facturas validadas en el rango
  | "ERR-EXPORT-002"  // Generacion Excel fallo
  // ── Auth / Permisos ──────────────────────────────────────
  | "ERR-AUTH-001"    // No autenticado
  | "ERR-AUTH-002"    // Rol insuficiente
  | "ERR-AUTH-003"    // Sin asignacion a cliente (worker)
  // ── Sistema (último recurso) ─────────────────────────────
  | "ERR-SYS-001";    // Error interno desconocido

export const ERROR_MESSAGES: Record<AppErrorCode, string> = {
  "ERR-UPLOAD-001": "El archivo supera el tamaño máximo permitido (20 MB).",
  "ERR-UPLOAD-002": "Tipo de archivo no permitido. Acepta PDF, JPG, PNG, WEBP o XML.",
  "ERR-UPLOAD-003": "No se pudo guardar el archivo. Inténtalo de nuevo en unos segundos.",
  "ERR-UPLOAD-004": "El periodo está cerrado. Reábrelo desde Cierres si necesitas modificarlo.",
  "ERR-UPLOAD-005": "No tienes acceso a este cliente.",
  "ERR-UPLOAD-006": "Esta factura ya estaba subida (duplicada por contenido).",
  "ERR-UPLOAD-007": "El nombre del archivo contiene caracteres no válidos.",

  "ERR-OCR-001": "El servicio de OCR no respondió. Reintenta el procesado en unos segundos.",
  "ERR-OCR-002": "El archivo no se pudo leer. Asegúrate de que el PDF o imagen no esté dañado.",
  "ERR-OCR-003": "El OCR tardó demasiado y se canceló. Si el archivo tiene muchas páginas, prueba a dividirlo.",
  "ERR-OCR-004": "El archivo original no se encuentra en almacenamiento. Vuelve a subirlo.",

  "ERR-VALIDATE-001": "El CIF del emisor y del receptor no pueden coincidir.",
  "ERR-VALIDATE-002": "El periodo contable está cerrado. No se puede validar.",
  "ERR-VALIDATE-003": "Otro gestor modificó esta factura. Recarga la página para ver los cambios.",
  "ERR-VALIDATE-004": "Hay líneas de IVA con valores no válidos (revisa porcentajes y signos).",

  "ERR-EXPORT-001": "No hay facturas validadas para exportar en el rango seleccionado.",
  "ERR-EXPORT-002": "No se pudo generar el Excel. Reintenta o contacta con soporte.",

  "ERR-AUTH-001": "No has iniciado sesión.",
  "ERR-AUTH-002": "No tienes permisos para esta acción.",
  "ERR-AUTH-003": "No tienes asignado este cliente.",

  "ERR-SYS-001": "Error inesperado. Intenta de nuevo o contacta con soporte.",
};

export type AppError = {
  code: AppErrorCode;
  message: string;
  /** Detalle técnico para copiar en el botón "copiar detalles". No se
   *  muestra al usuario directamente, solo via copia. */
  details?: string;
};

/** Crea un AppError listo para devolver desde un server action o API.
 *  El `details` se puede incluir libremente: stack traces, IDs, etc. */
export function appError(code: AppErrorCode, details?: string): AppError {
  return {
    code,
    message: ERROR_MESSAGES[code],
    details,
  };
}

/** Type-guard para distinguir AppError de otros payloads de error. */
export function isAppError(x: unknown): x is AppError {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    typeof (x as { code: unknown }).code === "string" &&
    (x as { code: string }).code.startsWith("ERR-")
  );
}
