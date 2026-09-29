/**
 * Content-Disposition de descargas cuyo nombre sale de datos del usuario,
 * como el nombre del cliente en el fichero del export (F-017).
 *
 * El valor de una cabecera HTTP solo admite bytes latin-1: con un "’", un
 * "–" o un "€" el Response de Node lanza TypeError, y un '"' o un ';' cortan
 * el nombre. Se manda un `filename` ASCII para quien no entienda otra cosa y
 * el nombre real en `filename*` (RFC 5987 / RFC 6266), que tiene prioridad.
 */
export function attachmentContentDisposition(filename: string): string {
  return `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** NFKD sin diacríticos; lo que no sea [A-Za-z0-9._-] pasa a "_". */
export function asciiFilename(filename: string): string {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return ascii || "descarga";
}

// encodeURIComponent deja sin escapar ' ( ) *, que no son attr-char en RFC 5987.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Nombre de fichero que propone una cabecera Content-Disposition. Prefiere
 * `filename*` (UTF-8) y si no se puede leer usa `filename`; si tampoco hay,
 * `fallback`. No lanza: un "%" suelto en el nombre hacía fallar la descarga.
 */
export function filenameFromContentDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Mal codificado: se prueba con filename=.
    }
  }
  const plain = header.match(/filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
  return plain?.[1] || plain?.[2] || fallback;
}
