import { describe, it, expect } from "vitest";
import { csvAmount, csvCell, csvDate, csvRow, formatBytes, originalPath, readmeText, safeZipName } from "@/lib/clientDataExportFormat";

describe("CSV de la descarga de datos (F-044)", () => {
  it("entre comillas solo lo que lleva separador, comillas o saltos", () => {
    expect(csvCell("Proveedor SL")).toBe("Proveedor SL");
    expect(csvCell("A; B")).toBe('"A; B"');
    expect(csvCell('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvCell("dos\nlíneas")).toBe('"dos\nlíneas"');
    expect(csvCell(null)).toBe("");
    expect(csvRow(["a", 1, null])).toBe("a;1;\r\n");
  });

  it("importes con coma y fechas AAAA-MM-DD", () => {
    expect(csvAmount({ toString: () => "1234.56" })).toBe("1234,56");
    expect(csvAmount(null)).toBe("");
    expect(csvDate(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
    expect(csvDate(null)).toBe("");
  });
});

describe("nombres dentro del ZIP", () => {
  it("sin barras ni caracteres que Windows no admite, y nunca vacíos", () => {
    expect(safeZipName("../../etc/passwd")).toBe("__.._etc_passwd");
    expect(safeZipName('a:b*c?"d<e>f|g')).toBe("a_b_c__d_e_f_g");
    expect(safeZipName("   ")).toBe("fichero");
    expect(safeZipName("Factura ñ.pdf")).toBe("Factura ñ.pdf");
  });

  it("los originales por periodo y con el id delante", () => {
    expect(originalPath({ id: "inv1", filename: "f.pdf", periodYear: 2026, periodMonth: 3 })).toBe("originales/2026-03/inv1_f.pdf");
  });

  it("tamaños legibles", () => {
    expect(formatBytes(11)).toBe("11 bytes");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1,5 MB");
  });
});

describe("LEEME.txt", () => {
  const base = { clientName: "Cliente SL", clientCif: "B1", generatedAt: "01/10/2026 10:00", generatedBy: "Ana", invoiceCount: 2, originalCount: 2, auditCount: 5, batchCount: 1, missingOriginals: 0 };
  it("explica cada fichero", () => {
    const text = readmeText(base);
    for (const name of ["facturas.json", "facturas.csv", "lineas_iva.csv", "originales/", "auditoria.csv", "lotes_exportados.json"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("ERRORES.txt");
    expect(text).toContain("no borra nada");
  });
  it("con originales que faltan, habla de ERRORES.txt", () => {
    expect(readmeText({ ...base, missingOriginals: 2 })).toContain("2 originales no se pudieron descargar");
  });
});
