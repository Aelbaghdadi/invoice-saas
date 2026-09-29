/**
 * Formato de los ficheros de la descarga de datos de un cliente (F-044), sin
 * BD ni almacenamiento: lo que se puede probar en unitarios.
 */

/**
 * Una celda CSV: entre comillas si lleva separador, comillas o saltos.
 *
 * Contra la inyeccion de formulas (OWASP): un texto que empieza por =, +, -,
 * @, tabulador o retorno lleva delante un apostrofo, para que Excel no lo
 * evalue (un nombre de proveedor «=HYPERLINK(...)» leido de un Facturae se
 * ejecutaba al abrir el CSV). Un numero plano no, para que los importes
 * negativos sigan siendo numeros.
 */
export function csvCell(value: unknown): string {
  if (value == null) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Una fila CSV con «;», como la abre Excel en español. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(";") + "\r\n";
}

/** BOM de UTF-8: sin él, Excel abre las tildes mal. */
export const CSV_BOM = "\uFEFF";

/** Importe con coma decimal (lo que espera Excel en español); vacío si no hay. */
export function csvAmount(value: { toString(): string } | null | undefined): string {
  return value == null ? "" : value.toString().replace(".", ",");
}

/** Fecha sin hora (AAAA-MM-DD), que Excel reconoce como fecha. */
export function csvDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

// Controles bidi (U+202E y compañia): «fdp.cmd» se veia como «dmc.pdf».
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Nombre de fichero seguro dentro del ZIP: sin barras (no puede crear
 * carpetas ni salir de la suya), sin caracteres que Windows no admite, sin
 * controles bidi, sin puntos ni espacios al final y nunca vacio.
 */
export function safeZipName(name: string, maxLength = 150): string {
  const cleaned = name
    .normalize("NFC")
    .replace(BIDI, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/, "");
  return cleaned || "fichero";
}

/** Extension por el tipo real del fichero, no por el nombre con que se subio. */
const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/xml": "xml",
  "text/xml": "xml",
};

/**
 * Nombre del original: la raiz del nombre subido (como mucho 80 caracteres)
 * y la extension de su tipo real. Recortar el nombre entero podia dejar otra
 * extension: «FFF….cmd.pdf» salia como «FFF….cmd» (revision 1 del PR #15).
 */
export function originalFileName(filename: string, fileType: string): string {
  const root = filename.replace(/\.[^.]*$/, "") || filename;
  return `${safeZipName(root, 80)}.${EXTENSIONS[fileType] ?? "bin"}`;
}

/** Ruta del original: por periodo y con el id delante (dos pueden llamarse igual). */
export function originalPath(invoice: { id: string; filename: string; fileType: string; periodYear: number; periodMonth: number }): string {
  const period = `${invoice.periodYear}-${String(invoice.periodMonth).padStart(2, "0")}`;
  return `originales/${period}/${invoice.id}_${originalFileName(invoice.filename, invoice.fileType)}`;
}

/** Tamaño legible («1,5 GB»). */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toLocaleString("es-ES", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export type ReadmeInput = {
  clientName: string;
  clientCif: string;
  generatedAt: string;
  generatedBy: string;
  invoiceCount: number;
  originalCount: number;
  auditCount: number;
  batchCount: number;
  missingOriginals: number;
};

/** El LEEME.txt: qué es cada fichero y cómo leerlo. */
export function readmeText(r: ReadmeInput): string {
  const lines = [
    `Datos de ${r.clientName} (CIF ${r.clientCif})`,
    `Descargados el ${r.generatedAt} por ${r.generatedBy}.`,
    "",
    "Contenido",
    "---------",
    "",
    `facturas.json`,
    `  Las ${r.invoiceCount} facturas del cliente con todos sus datos y sus líneas de IVA`,
    `  (campo vatLines). Importes con punto decimal y fechas en ISO 8601 (UTC).`,
    "",
    `facturas.csv`,
    `  Las mismas facturas, una por fila, con los datos principales. La columna`,
    `  «Original» dice dónde está su fichero dentro de este ZIP.`,
    "",
    `lineas_iva.csv`,
    `  Las líneas de IVA de cada factura (base, tipo, cuota y recargo de`,
    `  equivalencia), enlazadas por el id de la factura.`,
    "",
    `originales/`,
    `  Los ${r.originalCount} ficheros originales (PDF, imágenes o XML) tal como se`,
    `  subieron, por periodo (AAAA-MM). El nombre empieza por el id de la factura.`,
    "",
    `auditoria.csv`,
    `  Los ${r.auditCount} registros de auditoría de estas facturas: quién cambió qué`,
    `  y cuándo. Cada registro lleva su hash y el del anterior (cadena de hash):`,
    `  si alguien modificara uno, la cadena dejaría de cuadrar.`,
    "",
    `lotes_exportados.json`,
    `  Los ${r.batchCount} lotes de exportación a contabilidad en los que salió alguna`,
    `  de estas facturas, con los datos exactos que llevó cada una en el Excel.`,
    "",
  ];
  if (r.missingOriginals > 0) {
    lines.push(
      `ERRORES.txt`,
      `  ${r.missingOriginals} original${r.missingOriginals === 1 ? "" : "es"} no se ${r.missingOriginals === 1 ? "pudo" : "pudieron"} descargar del almacenamiento: la lista y el motivo.`,
      "",
    );
  }
  lines.push(
    "Los CSV van separados por «;», con coma decimal y en UTF-8, para abrirlos",
    "directamente en Excel en español. Las horas («Subida el», «Fecha» de la",
    "auditoría) van en hora de Madrid (dd/mm/aaaa hh:mm); la fecha de cada",
    "factura, en AAAA-MM-DD. En los JSON, todo en ISO 8601 y UTC.",
    "",
    "Un texto que empieza por =, +, -, @ o un tabulador lleva delante un",
    "apóstrofo (') para que Excel no lo ejecute como fórmula: ese apóstrofo no",
    "forma parte del valor.",
    "",
    "Comprobar la cadena de auditoría: el hash de cada registro es el SHA-256",
    "(en hexadecimal) de estos campos de auditoria.csv unidos por «|»:",
    "  Id del registro|Id de la factura|Id del usuario|Campo|Antes|Después|",
    "  Fecha exacta (UTC)|Hash del anterior",
    "con «Antes» y «Después» vacíos si no hay valor. «Hash del anterior» es el",
    "«Hash» del registro que dice «Anterior» (GENESIS en el primero).",
    "",
    "Esta descarga no borra nada: los datos siguen en FacturOCR.",
    "",
  );
  return lines.join("\r\n");
}
