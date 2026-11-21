/**
 * indice.xlsx del ZIP del ejercicio, sin BD: las hojas que da
 * archiveIndexSheets, con cada celda de su tipo.
 */
import * as XLSX from "xlsx";
import { ARCHIVE_INDEX_WIDTHS, type ArchiveIndexCell, type ArchiveIndexSheet } from "@/lib/archiveExportFormat";

const AMOUNT_FORMAT = "#,##0.00";
const DATE_FORMAT = "dd/mm/yyyy";
/** Día 0 de las fechas de Excel (con el error del 29/02/1900 incluido). */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/**
 * La celda de un valor: los importes como número, las fechas como fecha (sin
 * hora, por sus componentes UTC, como formatDateEs) y todo lo demás como
 * texto. Un texto es siempre texto: «=HYPERLINK(…)» en el nombre de un
 * proveedor no es una fórmula (el escritor no pone fórmulas: eso es la clave
 * «f», que aquí no se usa nunca).
 */
function cell(value: ArchiveIndexCell): XLSX.CellObject | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return { t: "n", v: value, z: AMOUNT_FORMAT };
  if (value instanceof Date) {
    const day = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
    return { t: "n", v: (day - EXCEL_EPOCH_MS) / DAY_MS, z: DATE_FORMAT };
  }
  return { t: "s", v: value };
}

/** El libro del índice, en un Buffer. */
export function archiveIndexXlsx(sheets: readonly ArchiveIndexSheet[]): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const worksheet: XLSX.WorkSheet = {};
    sheet.rows.forEach((row, r) => {
      row.forEach((value, c) => {
        const content = cell(value);
        if (content) worksheet[XLSX.utils.encode_cell({ r, c })] = content;
      });
    });
    const columns = Math.max(1, ...sheet.rows.map((row) => row.length));
    const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, sheet.rows.length - 1), c: columns - 1 } });
    worksheet["!ref"] = ref;
    worksheet["!autofilter"] = { ref };
    worksheet["!cols"] = ARCHIVE_INDEX_WIDTHS.slice(0, columns).map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }
  // bookSST: los textos van a la tabla de cadenas compartidas (t="s"), el
  // tipo de texto de siempre.
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", bookSST: true, compression: true }) as Buffer;
}
