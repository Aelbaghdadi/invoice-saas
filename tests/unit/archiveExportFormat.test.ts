import { describe, it, expect } from "vitest";
import { BRAND } from "@/lib/brand";
import {
  ARCHIVE_INDEX_HEADERS,
  archiveFormatLabel,
  archiveIndexRow,
  archiveIndexSheets,
  archiveReadme,
  archiveZipBytes,
  archiveZipFolder,
  archiveZipStem,
  checkArchiveFiles,
  dayInMadrid,
  planArchiveZip,
  type ArchiveFileRead,
  type ArchiveIndexInput,
  type ArchiveReadmeInput,
  type ArchiveStoredFile,
  type ArchiveZipInvoice,
} from "@/lib/archiveExportFormat";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const file = (storageKey: string, fileType = "application/pdf", sizeBytes: number | null = 100): ArchiveStoredFile => ({
  storageKey,
  fileType,
  filename: storageKey,
  fileHash: null,
  sizeBytes,
  createdAt: new Date("2026-03-05T10:00:00Z"),
});

let sequence = 0;
function invoice(overrides: Partial<ArchiveZipInvoice> = {}): ArchiveZipInvoice {
  const id = `inv${++sequence}`;
  return {
    invoiceId: id,
    status: "EXPORTED",
    type: "PURCHASE",
    register: { type: "PURCHASE", year: 2026, number: sequence },
    period: { year: 2026, month: 3 },
    invoiceNumber: `F-${sequence}`,
    thirdPartyName: "Proveedor SL",
    own: file(`k-${id}`),
    otherFormat: null,
    splitRoot: null,
    splitRootId: null,
    ...overrides,
  };
}

describe("rutas del ZIP del ejercicio", () => {
  it("carpeta por registro, serie y estado, y luego AAAA-MM; nombre con el nº, la factura y el tercero", () => {
    const received = invoice({ register: { type: "PURCHASE", year: 2026, number: 153 }, invoiceNumber: "F-123" });
    const issued = invoice({ type: "SALE", register: { type: "SALE", year: 2026, number: 7 }, period: { year: 2026, month: 11 } });
    const pending = invoice({ invoiceId: "cmabc", status: "PENDING_REVIEW", register: null });
    const rejected = invoice({ status: "REJECTED", register: null });
    const plan = planArchiveZip([received, issued, pending, rejected]);
    expect(plan.files.map((f) => f.path)).toEqual([
      "recibidas/2026-03/R-2026-0153 F-123 Proveedor SL.pdf",
      `emitidas/2026-11/E-2026-0007 ${issued.invoiceNumber} Proveedor SL.pdf`,
      `sin-registrar/2026-03/SR-cmabc ${pending.invoiceNumber} Proveedor SL.pdf`,
      `rechazadas/2026-03/SR-${rejected.invoiceId} ${rejected.invoiceNumber} Proveedor SL.pdf`,
    ]);
    // Numerada como emitida y corregida después a recibida: va con su serie.
    expect(archiveZipFolder({ status: "VALIDATED", register: { type: "SALE", year: 2026, number: 1 } })).toBe("emitidas");
  });

  it("los nombres son seguros: sin barras, ni caracteres de Windows, ni saltos, ni controles bidi", () => {
    const stem = archiveZipStem({
      invoiceId: "x",
      register: { type: "PURCHASE", year: 2026, number: 1 },
      invoiceNumber: "F/2026/1",
      thirdPartyName: "../Taller: «López»\n  y Cía.\u202Efdp.exe",
    });
    expect(stem).toBe("R-2026-0001 F_2026_1 .._Taller_ «López» y Cía.fdp.exe");
    expect(stem).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u202E]/);
    expect(archiveZipStem({ invoiceId: "x", register: null, invoiceNumber: null, thirdPartyName: "   " })).toBe("SR-x");
    expect(archiveZipStem({ invoiceId: "x", register: null, invoiceNumber: "N".repeat(300), thirdPartyName: null }).length).toBeLessThanOrEqual(120);
  });

  it("se ordenan bien: los números con ceros delante y las carpetas por periodo", () => {
    const plan = planArchiveZip([
      invoice({ register: { type: "PURCHASE", year: 2026, number: 2 }, period: { year: 2026, month: 2 } }),
      invoice({ register: { type: "PURCHASE", year: 2026, number: 10 }, period: { year: 2026, month: 10 } }),
    ]);
    const paths = plan.files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);
    expect(paths[0]).toMatch(/^recibidas\/2026-02\/R-2026-0002 /);
  });

  it("un Word adjunto va con su copia en PDF, cada uno con su extensión real", () => {
    const word = invoice({ register: { type: "PURCHASE", year: 2026, number: 3 }, invoiceNumber: "F-9", otherFormat: file("k-word", DOCX) });
    const plan = planArchiveZip([word]);
    expect(plan.files.map((f) => f.path)).toEqual([
      "recibidas/2026-03/R-2026-0003 F-9 Proveedor SL.docx",
      "recibidas/2026-03/R-2026-0003 F-9 Proveedor SL (copia).pdf",
    ]);
    expect(plan.placements.get(word.invoiceId)).toEqual({
      original: "recibidas/2026-03/R-2026-0003 F-9 Proveedor SL.docx",
      originalKey: "k-word",
      copy: "recibidas/2026-03/R-2026-0003 F-9 Proveedor SL (copia).pdf",
    });
  });

  it("de una división, el documento entero una sola vez, donde cae su primera parte", () => {
    const root = file("k-root", "application/pdf", 900);
    const p1 = invoice({ register: { type: "PURCHASE", year: 2026, number: 4 }, invoiceNumber: "T-1", splitRoot: root });
    const other = invoice({ register: { type: "PURCHASE", year: 2026, number: 5 } });
    const p2 = invoice({ register: null, status: "PENDING_REVIEW", invoiceNumber: "T-2", splitRoot: root });
    const plan = planArchiveZip([p1, other, p2]);
    expect(plan.files.map((f) => f.path)).toEqual([
      "recibidas/2026-03/R-2026-0004 T-1 Proveedor SL (documento entero).pdf",
      `recibidas/2026-03/R-2026-0005 ${other.invoiceNumber} Proveedor SL.pdf`,
    ]);
    expect(plan.placements.get(p2.invoiceId)?.original).toBe("recibidas/2026-03/R-2026-0004 T-1 Proveedor SL (documento entero).pdf");
    // Los ficheros de las partes (recortes que hizo la app) no van.
    expect(plan.files.some((f) => f.storageKey === p1.own.storageKey || f.storageKey === p2.own.storageKey)).toBe(false);
    // Con un Word en la raíz: el Word y la copia del documento entero, una vez.
    const word = file("k-root-word", DOCX);
    const withWord = planArchiveZip([
      invoice({ invoiceNumber: "T-1", register: { type: "PURCHASE", year: 2026, number: 6 }, splitRoot: root, otherFormat: word }),
      invoice({ invoiceNumber: "T-2", register: { type: "PURCHASE", year: 2026, number: 7 }, splitRoot: root, otherFormat: word }),
    ]);
    expect(withWord.files.map((f) => f.path)).toEqual([
      "recibidas/2026-03/R-2026-0006 T-1 Proveedor SL (documento entero).docx",
      "recibidas/2026-03/R-2026-0006 T-1 Proveedor SL (documento entero, copia).pdf",
    ]);
  });

  it("dos ficheros que se llamarían igual (también solo en mayúsculas) no se pisan", () => {
    const a = invoice({ register: null, invoiceId: "dup", invoiceNumber: "f-1", thirdPartyName: "x" });
    const b = invoice({ register: null, invoiceId: "DUP", invoiceNumber: "F-1", thirdPartyName: "X" });
    expect(planArchiveZip([a, b]).files.map((f) => f.path)).toEqual([
      "sin-registrar/2026-03/SR-dup f-1 x.pdf",
      "sin-registrar/2026-03/SR-DUP F-1 X (2).pdf",
    ]);
  });

  it("lo que ocupa: cada fichero una vez, y sin tamaño guardado cuenta el máximo", () => {
    const root = file("k-root", "application/pdf", 1_000);
    const plan = planArchiveZip([
      invoice({ own: file("a", "application/pdf", 10), otherFormat: file("w", DOCX, 5) }),
      invoice({ splitRoot: root }),
      invoice({ splitRoot: root }),
      invoice({ own: file("sin-tamaño", "application/pdf", null) }),
    ]);
    expect(archiveZipBytes(plan, 20)).toBe(10 + 5 + 1_000 + 20);
  });
});

describe("comprobación de los originales (checkArchiveFiles)", () => {
  const hashed = (storageKey: string, fileHash: string | null, fileType = "application/pdf"): ArchiveStoredFile =>
    ({ ...file(storageKey, fileType), fileHash });
  const reads = (entries: [string, ArchiveFileRead][]) => new Map<string, ArchiveFileRead>(entries);

  it("cada factura se compara con SU huella: dos subidas antiguas con la misma clave llevan el aviso las dos", () => {
    const a = invoice({ register: null, invoiceNumber: "A-1", own: hashed("k-igual", "AA") });
    const b = invoice({ register: null, invoiceNumber: "B-2", own: hashed("k-igual", "bb") });
    const plan = planArchiveZip([a, b]);
    expect(plan.files).toHaveLength(1);
    const path = plan.files[0].path;
    // En el almacenamiento quedó lo de la segunda.
    const { originals, errors } = checkArchiveFiles([a, b], plan, reads([["k-igual", { sha256: "bb" }]]));
    expect(originals.get(a.invoiceId)).toEqual({ sha256: "bb", problems: ["hash", "shared"] });
    expect(originals.get(b.invoiceId)).toEqual({ sha256: "bb", problems: ["shared"] });
    expect(errors).toEqual([
      `${path}\tes el mismo fichero guardado de varias facturas (nº A-1, nº B-2): se subieron con el mismo nombre y solo se conserva uno`,
      `${path}\tnº A-1: la huella SHA-256 no coincide con la que se guardó al subirlo (guardada AA; la del fichero del ZIP es bb)`,
    ]);
    expect(archiveIndexRow(indexInput({ original: { fileType: "application/pdf", path, sha256: "bb", problems: ["hash", "shared"] } })).at(-1))
      .toBe("El original no coincide con el que se subió: ver ERRORES.txt; El fichero guardado es el mismo que el de otra factura: ver ERRORES.txt");
  });

  it("las partes de una división comparten el documento entero sin aviso; si su huella no coincide, una sola línea", () => {
    const root = hashed("k-root", "rr");
    const p1 = invoice({ invoiceNumber: "T-1", splitRoot: root, splitRootId: "raiz" });
    const p2 = invoice({ invoiceNumber: null, register: null, status: "PENDING_REVIEW", splitRoot: root, splitRootId: "raiz" });
    const plan = planArchiveZip([p1, p2]);
    const ok = checkArchiveFiles([p1, p2], plan, reads([["k-root", { sha256: "rr" }]]));
    expect([...ok.originals.values()]).toEqual([{ sha256: "rr", problems: [] }, { sha256: "rr", problems: [] }]);
    expect(ok.errors).toEqual([]);
    const bad = checkArchiveFiles([p1, p2], plan, reads([["k-root", { sha256: "xx" }]]));
    expect([...bad.originals.values()].map((o) => o.problems)).toEqual([["hash"], ["hash"]]);
    expect(bad.errors).toEqual([
      `${plan.files[0].path}\tla huella SHA-256 no coincide con la que se guardó al subirlo (guardada rr; la del fichero del ZIP es xx)`,
    ]);
    // Sin nº de factura, el aviso de una clave compartida dice su código.
    const loose = invoice({ invoiceNumber: null, register: null, own: hashed("k-root", "rr") });
    const shared = checkArchiveFiles([p1, loose], planArchiveZip([p1, loose]), reads([["k-root", { sha256: "rr" }]]));
    expect(shared.errors).toEqual([expect.stringContaining(`(nº T-1, código ${loose.invoiceId})`)]);
    expect(shared.originals.get(loose.invoiceId)?.problems).toEqual(["shared"]);
  });

  it("de un Word, el índice mira el Word y la copia en PDF también se comprueba; lo que falta va con su motivo", () => {
    const word = invoice({ invoiceNumber: "F-W", own: hashed("k-pdf", "pp"), otherFormat: hashed("k-word", "ww", DOCX) });
    const missing = invoice({ invoiceNumber: "F-M", own: hashed("k-falta", "mm") });
    const plan = planArchiveZip([word, missing]);
    const { originals, errors } = checkArchiveFiles([word, missing], plan, reads([
      ["k-word", { sha256: "ww" }],
      ["k-pdf", { sha256: "otra" }],
      ["k-falta", { missing: "no está en el almacenamiento" }],
    ]));
    expect(originals.get(word.invoiceId)).toEqual({ sha256: "ww", problems: [] });
    expect(originals.get(missing.invoiceId)).toEqual({ sha256: null, problems: ["missing"] });
    expect(errors).toEqual([
      `${plan.files[1].path}\tla huella SHA-256 no coincide con la que se guardó al subirlo (guardada pp; la del fichero del ZIP es otra)`,
      `${plan.files[2].path}\tno está en el almacenamiento`,
    ]);
  });
});

function indexInput(overrides: Partial<ArchiveIndexInput> = {}): ArchiveIndexInput {
  return {
    folder: "recibidas",
    registerNumber: "R-2026/0153",
    periodLabel: "Marzo 2026",
    type: "PURCHASE",
    status: "EXPORTED",
    receivedAt: new Date("2026-03-04T23:30:00Z"),
    invoiceDate: new Date("2026-03-02T00:00:00Z"),
    invoiceNumber: "F-123",
    thirdPartyName: "Proveedor SL",
    thirdPartyCif: "B12345674",
    taxBase: 100,
    vatAmount: 21,
    irpfAmount: null,
    totalAmount: 121,
    currency: null,
    medium: "ELECTRONIC",
    mediumReasonLabel: "PDF con texto: no es un escaneo",
    original: { fileType: "application/pdf", path: "recibidas/2026-03/R-2026-0153 F-123 Proveedor SL.pdf", sha256: "ab".repeat(32), problems: [] },
    copyFileType: null,
    retainUntil: new Date("2032-12-31T00:00:00Z"),
    retentionHoldReason: null,
    warnings: [],
    rejectionReason: null,
    ...overrides,
  };
}

describe("índice del ZIP", () => {
  it("cabeceras con tildes, y «Original» se llama como en facturas.csv", () => {
    expect([...ARCHIVE_INDEX_HEADERS]).toEqual([
      "Nº de registro", "Periodo", "Tipo", "Estado", "Recibida el", "Fecha", "Nº de factura", "Tercero", "NIF",
      "Base", "Cuota IVA", "Retención", "Total", "Original electrónico o en papel", "Formato", "Fichero en el ZIP",
      "SHA-256", "Conservar hasta", "Avisos",
    ]);
  });

  it("una fila: importes como número, fechas como fecha (la llegada, en hora de Madrid), huella y conservar hasta", () => {
    const row = archiveIndexRow(indexInput());
    expect(row).toHaveLength(ARCHIVE_INDEX_HEADERS.length);
    expect(row).toEqual([
      "R-2026/0153", "Marzo 2026", "Recibida", "Exportada",
      new Date("2026-03-05T00:00:00Z"), new Date("2026-03-02T00:00:00Z"),
      "F-123", "Proveedor SL", "B12345674", 100, 21, null, 121,
      "Electrónico", "PDF", "recibidas/2026-03/R-2026-0153 F-123 Proveedor SL.pdf", "ab".repeat(32),
      new Date("2032-12-31T00:00:00Z"), null,
    ]);
  });

  it("por confirmar con su motivo, el Word con su copia, conservar más y los avisos", () => {
    const row = archiveIndexRow(indexInput({
      medium: null,
      mediumReasonLabel: "Escaneo: falta confirmar si hay papel",
      original: { fileType: DOCX, path: "x.docx", sha256: null, problems: ["missing"] },
      copyFileType: "application/pdf",
      retainUntil: null,
      retentionHoldReason: "FIXED_ASSET",
      warnings: ["Registrada tarde", "Parte 2 de 3"],
      status: "REJECTED",
      rejectionReason: "Duplicada",
      currency: "USD",
    }));
    const at = (header: (typeof ARCHIVE_INDEX_HEADERS)[number]) => row[ARCHIVE_INDEX_HEADERS.indexOf(header)];
    expect(at("Original electrónico o en papel")).toBe("Por confirmar (Escaneo: falta confirmar si hay papel)");
    expect(at("Formato")).toBe("Word (.docx), con copia en PDF");
    expect(at("SHA-256")).toBeNull();
    expect(at("Conservar hasta")).toBe("Sin fecha: conservar más (Inmovilizado)");
    expect(at("Avisos")).toBe("Registrada tarde; Parte 2 de 3; Rechazada: Duplicada; Importes en USD; Falta el original: ver ERRORES.txt");
    expect(archiveIndexRow(indexInput({ original: { fileType: "application/pdf", path: "x.pdf", sha256: "cd", problems: ["hash"] } }))
      .at(-1)).toBe("El original no coincide con el que se subió: ver ERRORES.txt");
  });

  it("las hojas: Recibidas, Emitidas, Sin registrar y, si se piden, Rechazadas, cada una con su cabecera", () => {
    const rows = [
      indexInput({ folder: "recibidas", invoiceNumber: "R1" }),
      indexInput({ folder: "emitidas", invoiceNumber: "E1" }),
      indexInput({ folder: "sin-registrar", invoiceNumber: "S1" }),
      indexInput({ folder: "recibidas", invoiceNumber: "R2" }),
      indexInput({ folder: "rechazadas", invoiceNumber: "X1" }),
    ];
    const numbers = (sheets: ReturnType<typeof archiveIndexSheets>) =>
      sheets.map((s) => [s.name, s.rows.slice(1).map((r) => r[ARCHIVE_INDEX_HEADERS.indexOf("Nº de factura")])]);
    const all = archiveIndexSheets(rows, { onlyRegistered: false, includeRejected: true });
    expect(numbers(all)).toEqual([["Recibidas", ["R1", "R2"]], ["Emitidas", ["E1"]], ["Sin registrar", ["S1"]], ["Rechazadas", ["X1"]]]);
    // La llegada: «Recibida el» en Recibidas, «Subida el» en Emitidas y las dos en las hojas que las mezclan.
    const arrival = (sheet: (typeof all)[number]) => sheet.rows[0][ARCHIVE_INDEX_HEADERS.indexOf("Recibida el")];
    expect(all.map((sheet) => [sheet.name, arrival(sheet)])).toEqual([
      ["Recibidas", "Recibida el"], ["Emitidas", "Subida el"], ["Sin registrar", "Recibida o subida el"], ["Rechazadas", "Recibida o subida el"],
    ]);
    expect(all[0].rows[0]).toEqual([...ARCHIVE_INDEX_HEADERS]);
    for (const sheet of all) {
      expect(sheet.rows[0].filter((_, i) => i !== ARCHIVE_INDEX_HEADERS.indexOf("Recibida el")))
        .toEqual(ARCHIVE_INDEX_HEADERS.filter((header) => header !== "Recibida el"));
    }
    expect(archiveIndexSheets(rows, { onlyRegistered: false, includeRejected: false }).map((s) => s.name))
      .toEqual(["Recibidas", "Emitidas", "Sin registrar"]);
    expect(archiveIndexSheets(rows, { onlyRegistered: true, includeRejected: true }).map((s) => s.name)).toEqual(["Recibidas", "Emitidas"]);
  });

  it("formato del original y día en Madrid", () => {
    expect(archiveFormatLabel("application/xml", null)).toBe("XML");
    expect(archiveFormatLabel("image/jpeg", null)).toBe("Imagen JPG");
    expect(archiveFormatLabel("application/msword", "application/pdf")).toBe("Word (.doc), con copia en PDF");
    expect(archiveFormatLabel("application/x-desconocido", null)).toBe("BIN");
    // A las 00:30 en Madrid ya es el día siguiente (y en verano, a las 22:30 UTC).
    expect(dayInMadrid(new Date("2026-03-04T23:30:00Z"))).toEqual(new Date("2026-03-05T00:00:00Z"));
    expect(dayInMadrid(new Date("2026-07-04T22:30:00Z"))).toEqual(new Date("2026-07-05T00:00:00Z"));
    expect(dayInMadrid(new Date("2026-07-04T21:30:00Z"))).toEqual(new Date("2026-07-04T00:00:00Z"));
  });
});

describe("LEEME.txt del ZIP del ejercicio", () => {
  const base: ArchiveReadmeInput = {
    clientName: "Panadería López SL",
    clientCif: "B12345674",
    fiscalYearLabel: "2026",
    quarterLabel: null,
    onlyRegistered: false,
    includeRejected: false,
    generatedAt: "20/11/2026 10:00",
    invoiceCount: 12,
    fileCount: 11,
    errorCount: 0,
    sheets: ["Recibidas", "Emitidas", "Sin registrar"],
  };

  it("dice que el nº es del archivo y no el de A3, y que el papel no es una digitalización certificada", () => {
    const text = archiveReadme(base);
    expect(text).toContain("Archivo de facturas de Panadería López SL (CIF B12345674)");
    expect(text).toContain("Ejercicio 2026 · todas las facturas");
    expect(text).toMatch(/No es el nº que\r\npone A3 al importar el Excel, y puede no coincidir con él/);
    expect(text).toMatch(/no es una\r\n {2}digitalización certificada/);
    expect(text).toContain("indice.xlsx");
    expect(text).toContain("sin-registrar/");
    expect(text).not.toContain("rechazadas/");
    expect(text).not.toContain("ERRORES.txt");
    expect(text.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
  });

  it("no lleva nombres ni correos del personal: ni siquiera se le pasan", () => {
    const text = archiveReadme(base);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\bpor\s+[A-ZÁÉÍÓÚ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚ]/);
    expect(Object.keys(base).sort()).toEqual([
      "clientCif", "clientName", "errorCount", "fileCount", "fiscalYearLabel", "generatedAt", "includeRejected",
      "invoiceCount", "onlyRegistered", "quarterLabel", "sheets",
    ]);
  });

  it("con trimestre, solo registradas, rechazadas o errores, lo cuenta", () => {
    expect(archiveReadme({ ...base, quarterLabel: "T2 (Abril – Junio 2026)", onlyRegistered: true }))
      .toContain("Ejercicio 2026 · T2 (Abril – Junio 2026) · solo las facturas registradas");
    const registered = archiveReadme({ ...base, onlyRegistered: true });
    expect(registered).not.toContain("sin-registrar/");
    const withRejected = archiveReadme({ ...base, includeRejected: true, errorCount: 2 });
    expect(withRejected).toContain("rechazadas/");
    expect(withRejected).toContain("2 originales que faltan o que no coinciden");
  });

  it("habla del producto con el nombre que ve el cliente, no con el interno", () => {
    const text = archiveReadme(base);
    expect(text).not.toMatch(/FacturOCR/i);
    expect(text).toContain(`Generado el 20/11/2026 10:00 con ${BRAND}.`);
    expect(text).toContain(`el archivo sigue en ${BRAND}.`);
  });

  it("concuerda en número: una factura, ninguna, y los ficheros", () => {
    const many = archiveReadme(base);
    expect(many).toContain("  Las 12 facturas, en el orden del archivo");
    expect(many).toContain("- Van tal como llegaron (11 ficheros)");
    const one = archiveReadme({ ...base, invoiceCount: 1, fileCount: 1 });
    expect(one).toContain("  La factura, en el orden del archivo");
    expect(one).toContain("- Van tal como llegaron (1 fichero)");
    expect(one).not.toMatch(/\b(Las|los) 1 /);
    const none = archiveReadme({ ...base, invoiceCount: 0, fileCount: 0 });
    expect(none).toContain("  No hay facturas en este periodo: las hojas solo llevan la cabecera.");
    expect(none).toContain("- Van tal como llegaron (ningún fichero)");
    expect(none).not.toMatch(/\b(Las|los) 0 /);
    expect(none).toContain("  Hojas: Recibidas, Emitidas, Sin registrar.");
  });
});
