import { attachmentContentDisposition } from "@/lib/contentDisposition";

/**
 * Tipos que /api/invoices/[id]/raw muestra inline: los que el navegador pinta
 * sin ejecutar nada (PDF e imágenes raster). Todo lo demás se descarga.
 *
 * El original lo sube un tercero (el cliente, o su proveedor a través de él) y
 * se sirve desde nuestro propio origen: un "XML" que en realidad es XHTML o
 * SVG con <script> se ejecutaría con la sesión del gestor al abrirlo (F-002).
 * Es lista blanca y no negra porque `fileType` no siempre sale de los magic
 * bytes: al dividir una factura se guarda el MIME del data URL del navegador.
 */
export const INLINE_FILE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

/**
 * Content-Type y Content-Disposition del original de una factura. Lo que se
 * descarga conserva el nombre con el que se subió; sin nombre, factura_<id>.
 * La CSP sandbox y nosniff de esa ruta van en next.config.ts: Next descarta
 * las cabeceras del route handler que ya trae la configuración.
 */
export function invoiceFileHeaders(
  fileType: string | null | undefined,
  invoiceId: string,
  filename?: string | null,
): { "Content-Type": string; "Content-Disposition": string } {
  const mime = (fileType ?? "").split(";")[0].trim().toLowerCase();
  if (INLINE_FILE_TYPES.has(mime)) {
    return { "Content-Type": mime, "Content-Disposition": "inline" };
  }
  const extension = mime.endsWith("/xml") || mime.endsWith("+xml") ? ".xml" : "";
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentContentDisposition(
      filename?.trim() || `factura_${invoiceId}${extension}`,
    ),
  };
}
