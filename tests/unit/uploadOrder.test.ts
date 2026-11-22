import { describe, it, expect } from "vitest";
import {
  compareUploadNames,
  isOfficeFileName,
  isTacoFileName,
  moveItem,
  sortByUploadName,
  sortByUploadTime,
  uploadFileExtension,
} from "@/lib/uploadOrder";

const sortNames = (names: string[]) => sortByUploadName(names, (name) => name);

describe("compareUploadNames y sortByUploadName", () => {
  it("orden natural del escáner: «Scan» < «Scan (1)» < «Scan (2)» < «Scan (10)»", () => {
    expect(sortNames(["Scan (10).pdf", "Scan (2).pdf", "Scan.pdf", "Scan (1).pdf"])).toEqual([
      "Scan.pdf",
      "Scan (1).pdf",
      "Scan (2).pdf",
      "Scan (10).pdf",
    ]);
  });

  it("con ceros delante y con números de distinta longitud", () => {
    expect(sortNames(["SCAN0010.jpg", "SCAN0009.jpg"])).toEqual(["SCAN0009.jpg", "SCAN0010.jpg"]);
    expect(sortNames(["Escaneo 10.pdf", "Escaneo 2.pdf"])).toEqual(["Escaneo 2.pdf", "Escaneo 10.pdf"]);
    expect(sortNames(["doc00123520261121.pdf", "doc9.pdf", "doc00123420261121.pdf"])).toEqual([
      "doc9.pdf",
      "doc00123420261121.pdf",
      "doc00123520261121.pdf",
    ]);
    expect(sortNames(["20261121_101504.pdf", "20261121_101503.pdf"])).toEqual(["20261121_101503.pdf", "20261121_101504.pdf"]);
  });

  it("sin distinguir mayúsculas ni tildes: el desempate es siempre el mismo", () => {
    // Iguales frente a los demás nombres…
    expect(sortNames(["Gasto.pdf", "factura.pdf", "Albarán.pdf", "Factura.PDF"])).toEqual([
      "Albarán.pdf",
      "Factura.PDF",
      "factura.pdf",
      "Gasto.pdf",
    ]);
    // …y entre ellos, por código, llegue en el orden que llegue.
    expect(sortNames(["factura.pdf", "Factura.PDF"])).toEqual(["Factura.PDF", "factura.pdf"]);
    expect(Math.sign(compareUploadNames("Factura.PDF", "factura.pdf"))).toBe(-Math.sign(compareUploadNames("factura.pdf", "Factura.PDF")));
    // «Página» = «Pagina»: manda el número.
    expect(sortNames(["Pagina 10.pdf", "Página 2.pdf"])).toEqual(["Página 2.pdf", "Pagina 10.pdf"]);
  });

  it("la extensión solo desempata", () => {
    expect(sortNames(["b.jpg", "a.pdf", "a.jpg"])).toEqual(["a.jpg", "a.pdf", "b.jpg"]);
    expect(sortNames(["Scan 2.pdf", "Scan 10.jpg"])).toEqual(["Scan 2.pdf", "Scan 10.jpg"]);
  });

  it("es estable: dos nombres idénticos se quedan como llegaron, y no toca la lista", () => {
    const items = [
      { id: "segundo", name: "x.pdf" },
      { id: "b", name: "b.pdf" },
      { id: "primero", name: "x.pdf" },
    ];
    const sorted = sortByUploadName(items, (item) => item.name);
    expect(sorted.map((item) => item.id)).toEqual(["b", "segundo", "primero"]);
    expect(items.map((item) => item.id)).toEqual(["segundo", "b", "primero"]);
    expect(compareUploadNames("x.pdf", "x.pdf")).toBe(0);
  });
});

describe("moveItem", () => {
  const list = ["a", "b", "c", "d"];

  it("arriba, abajo y a cualquier posición", () => {
    expect(moveItem(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
    expect(moveItem(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("fuera de rango o al mismo sitio: una copia igual", () => {
    for (const [from, to] of [[0, 4], [-1, 0], [4, 0], [1, 1], [1.5, 0]]) {
      const moved = moveItem(list, from, to);
      expect(moved).toEqual(list);
      expect(moved).not.toBe(list);
    }
  });
});

describe("tipos de fichero", () => {
  it("un taco admite PDF e imágenes, no XML ni ficheros sin extensión", () => {
    for (const name of ["a.pdf", "A.PDF", "foto.jpg", "foto.JPEG", "b.png", "c.webp", "IMG_0001.HEIC"]) {
      expect(isTacoFileName(name), name).toBe(true);
    }
    for (const name of ["factura.xml", "escaneo", "escaneo.tif", ".pdf", "a.pdf.zip"]) {
      expect(isTacoFileName(name), name).toBe(false);
    }
  });

  it("Word, Excel, OpenDocument y RTF se reconocen para avisar", () => {
    for (const name of ["a.doc", "a.docx", "a.docm", "a.xls", "a.XLSX", "a.xlsm", "a.odt", "a.ods", "a.rtf"]) {
      expect(isOfficeFileName(name), name).toBe(true);
    }
    for (const name of ["a.pdf", "a.xml", "a.csv", "doc", "a.jpg"]) {
      expect(isOfficeFileName(name), name).toBe(false);
    }
  });

  it("la extensión va en minúsculas y sin punto", () => {
    expect(uploadFileExtension("Escaneo.Final.PDF")).toBe("pdf");
    expect(uploadFileExtension("sinextension")).toBe("");
    expect(uploadFileExtension(".oculto")).toBe("");
  });
});

describe("sortByUploadTime", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("por la hora del fichero aunque el nombre diga otra cosa, y con la misma hora por el nombre", () => {
    const files = [
      { name: "Escaneo 3 dic 2026.pdf", time: at("2026-12-03T10:00:00Z") },
      { name: "Escaneo 21 nov 2026.pdf", time: at("2026-11-21T10:00:00Z") },
      { name: "Escaneo 10.pdf", time: at("2026-11-21T10:00:00Z") },
      { name: "Escaneo 9.pdf", time: at("2026-11-21T10:00:00Z") },
    ];
    // Por nombre, «3 dic» iría antes que «21 nov».
    expect(sortByUploadName(files, (f) => f.name)[0].name).toBe("Escaneo 3 dic 2026.pdf");
    expect(sortByUploadTime(files, (f) => f.time, (f) => f.name).map((f) => f.name)).toEqual([
      "Escaneo 9.pdf",
      "Escaneo 10.pdf",
      "Escaneo 21 nov 2026.pdf",
      "Escaneo 3 dic 2026.pdf",
    ]);
  });

  it("una hora que no es un número va al final", () => {
    const files = [{ name: "b", time: Number.NaN }, { name: "a", time: 5 }];
    expect(sortByUploadTime(files, (f) => f.time, (f) => f.name).map((f) => f.name)).toEqual(["a", "b"]);
  });
});
