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
export const CSV_BOM = "﻿";

/** Importe con coma decimal (lo que espera Excel en español); vacío si no hay. */
export function csvAmount(value: { toString(): string } | null | undefined): string {
  return value == null ? "" : value.toString().replace(".", ",");
}

/** Fecha sin hora (AAAA-MM-DD), que Excel reconoce como fecha. */
export function csvDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

/**
 * Nombre de fichero seguro dentro del ZIP: sin barras (no puede crear
 * carpetas ni salir de la suya), sin caracteres que Windows no admite y sin
 * nombres vacíos.
 */
export function safeZipName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 150);
  return cleaned || "fichero";
}

/** Ruta del original: por periodo y con el id delante (dos pueden llamarse igual). */
export function originalPath(invoice: { id: string; filename: string; periodYear: number; periodMonth: number }): string {
  const period = `${invoice.periodYear}-${String(invoice.periodMonth).padStart(2, "0")}`;
  return `originales/${period}/${invoice.id}_${safeZipName(invoice.filename)}`;
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
    "directamente en Excel en español.",
    "",
    "Esta descarga no borra nada: los datos siguen en FacturOCR.",
    "",
  );
  return lines.join("\r\n");
}
