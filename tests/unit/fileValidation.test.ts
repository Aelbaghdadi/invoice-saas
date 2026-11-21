import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";
import {
  detectFileKind,
  validateUploadedFile,
  canonicalMime,
  validateOriginalAttachment,
  ORIGINAL_ATTACHMENT_MAX_BYTES,
} from "@/lib/fileValidation";

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function padTo(b: Uint8Array, n: number): Uint8Array {
  if (b.length >= n) return b;
  const out = new Uint8Array(n);
  out.set(b);
  return out;
}

describe("detectFileKind", () => {
  it("detects PDF", () => {
    const pdf = padTo(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34), 16);
    expect(detectFileKind(pdf)).toBe("pdf");
  });

  it("detects JPEG", () => {
    const jpg = padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 16);
    expect(detectFileKind(jpg)).toBe("jpeg");
  });

  it("detects PNG", () => {
    const png = padTo(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 16);
    expect(detectFileKind(png)).toBe("png");
  });

  it("detects WebP", () => {
    const webp = padTo(
      bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
      16,
    );
    expect(detectFileKind(webp)).toBe("webp");
  });

  it("detects HEIC", () => {
    const heic = padTo(
      bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63),
      16,
    );
    expect(detectFileKind(heic)).toBe("heic");
  });

  it("detects XML with BOM and declaration", () => {
    const xml = padTo(
      bytes(0xef, 0xbb, 0xbf, 0x3c, 0x3f, 0x78, 0x6d, 0x6c),
      16,
    );
    expect(detectFileKind(xml)).toBe("xml");
  });

  it("detects bare XML starting with <", () => {
    const xml = padTo(bytes(0x3c, 0x66, 0x65, 0x3a, 0x46, 0x61, 0x63), 16);
    expect(detectFileKind(xml)).toBe("xml");
  });

  it("returns null for too-short buffer", () => {
    expect(detectFileKind(bytes(0x25, 0x50))).toBeNull();
  });

  it("returns null for unknown signature", () => {
    const garbage = padTo(bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07), 16);
    expect(detectFileKind(garbage)).toBeNull();
  });

  it("returns null for text file", () => {
    const txt = padTo(bytes(0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64), 16);
    expect(detectFileKind(txt)).toBeNull();
  });
});

describe("validateUploadedFile", () => {
  const pdf = padTo(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), 16);
  const jpg = padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 16);

  it("accepts when content and extension match", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.pdf" });
    expect(r).toEqual({ ok: true, kind: "pdf" });
  });

  it("rejects when extension does not match content", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.jpg" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no coincide/i);
  });

  it("accepts jpg and jpeg extensions for JPEG", () => {
    expect(validateUploadedFile({ buffer: jpg, filename: "a.jpg" }).ok).toBe(true);
    expect(validateUploadedFile({ buffer: jpg, filename: "a.jpeg" }).ok).toBe(true);
  });

  it("rejects unknown content even with valid extension", () => {
    const garbage = padTo(bytes(0, 0, 0, 0, 0, 0, 0, 0), 16);
    const r = validateUploadedFile({ buffer: garbage, filename: "x.pdf" });
    expect(r.ok).toBe(false);
  });

  it("rejects filename whose extension does not match content", () => {
    const r = validateUploadedFile({ buffer: pdf, filename: "factura.docx" });
    expect(r.ok).toBe(false);
  });
});

describe("canonicalMime", () => {
  it("returns correct MIME types", () => {
    expect(canonicalMime("pdf")).toBe("application/pdf");
    expect(canonicalMime("jpeg")).toBe("image/jpeg");
    expect(canonicalMime("png")).toBe("image/png");
    expect(canonicalMime("webp")).toBe("image/webp");
    expect(canonicalMime("heic")).toBe("image/heic");
    expect(canonicalMime("xml")).toBe("application/xml");
  });
});

// ── Originales en otros formatos (R19) ──────────────────────────────────────

const DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DOCM_MAIN = "application/vnd.ms-word.document.macroEnabled.main+xml";

/** Un documento OLE2 de verdad, con la librería que ya usa la app: sus
 *  flujos por ruta («Macros/VBA/dir») y, si se da, su contenido. */
function ole2(...streams: (string | [string, Uint8Array])[]): Uint8Array {
  const container = XLSX.CFB.utils.cfb_new();
  for (const stream of streams) {
    const [path, content] = typeof stream === "string" ? [stream, new Uint8Array([1, 2, 3])] : stream;
    XLSX.CFB.utils.cfb_add(container, `/${path}`, Buffer.from(content));
  }
  return new Uint8Array(XLSX.CFB.write(container, { type: "buffer" }) as Buffer);
}

/** Un nombre de flujo tal como va escrito en el directorio (UTF-16LE). */
const utf16le = (text: string) => new Uint8Array([...text].flatMap((ch) => [ch.charCodeAt(0), 0]));

/** Un flujo Workbook (BIFF8) mínimo: BOF, una hoja del tipo dado (0 hoja, 1
 *  macros XLM, 6 módulo VBA), EOF y, detrás, una hoja de macros que ya no es
 *  de la parte global del libro. */
function biff(sheetType: number): Uint8Array {
  const record = (type: number, data: number[]) => [type & 0xff, type >> 8, data.length & 0xff, data.length >> 8, ...data];
  return new Uint8Array([
    ...record(0x0809, [0x00, 0x06, 0x05, 0x00, 0, 0, 0, 0]),
    ...record(0x0085, [0, 0, 0, 0, 0x00, sheetType, 1, 0, 0x41]),
    ...record(0x000a, []),
    ...record(0x0085, [0, 0, 0, 0, 0x00, 0x01, 1, 0, 0x42]),
  ]);
}

/** Un ZIP de Office con su [Content_Types].xml. */
function ooxml(mainType: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="${mainType}"/></Types>`),
    "word/document.xml": strToU8("<w:document/>"),
    ...extra,
  });
}

/** Un OpenDocument: «mimetype» primero y sin comprimir. */
function odf(mimetype: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ mimetype: [strToU8(mimetype), { level: 0 }], "content.xml": strToU8("<office:document-content/>"), ...extra });
}

/** Un .xlsx de verdad, hecho con la librería que ya usa la app. */
function realXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Factura", 121]]), "Hoja1");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

const PDF = padTo(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34), 64);
const RTF = strToU8(String.raw`{\rtf1\ansi Factura 1}`);

describe("validateOriginalAttachment", () => {
  it("acepta .doc y .xls (OLE2), .docx y .xlsx, .odt y .ods, y .rtf, con su tipo", () => {
    expect(validateOriginalAttachment(ole2("WordDocument", "1Table"), "factura.doc"))
      .toEqual({ ok: true, kind: "doc", mime: "application/msword" });
    expect(validateOriginalAttachment(ole2(["Workbook", biff(0)]), "factura.xls"))
      .toEqual({ ok: true, kind: "xls", mime: "application/vnd.ms-excel" });
    // Excel 5/95 llama «Book» a su flujo.
    expect(validateOriginalAttachment(ole2("Book"), "vieja.XLS")).toMatchObject({ ok: true, kind: "xls" });
    expect(validateOriginalAttachment(ooxml(DOCX_MAIN), "Factura 12.DOCX"))
      .toEqual({ ok: true, kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(validateOriginalAttachment(realXlsx(), "libro.xlsx"))
      .toEqual({ ok: true, kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(validateOriginalAttachment(odf("application/vnd.oasis.opendocument.text"), "f.odt"))
      .toEqual({ ok: true, kind: "odt", mime: "application/vnd.oasis.opendocument.text" });
    expect(validateOriginalAttachment(odf("application/vnd.oasis.opendocument.spreadsheet"), "f.ods"))
      .toEqual({ ok: true, kind: "ods", mime: "application/vnd.oasis.opendocument.spreadsheet" });
    expect(validateOriginalAttachment(RTF, "f.rtf")).toEqual({ ok: true, kind: "rtf", mime: "application/rtf" });
  });

  it("rechaza un .doc con bytes de PDF, un .exe renombrado y un fichero sin extensión", () => {
    expect(validateOriginalAttachment(PDF, "factura.doc")).toMatchObject({ ok: false });
    const exe = padTo(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03), 64);
    expect(validateOriginalAttachment(exe, "factura.doc")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(exe, "factura.docx")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(ole2("WordDocument"), "factura")).toMatchObject({ ok: false });
  });

  it("rechaza los documentos con macros: .docm, .xlsm, un .docx con macros dentro y un .doc con proyecto VBA", () => {
    expect(validateOriginalAttachment(ooxml(DOCX_MAIN), "factura.docm")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(realXlsx(), "libro.xlsm")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(ooxml(DOCM_MAIN), "factura.docx")).toMatchObject({ ok: false, reason: expect.stringMatching(/macros/) });
    expect(validateOriginalAttachment(ooxml(DOCX_MAIN, { "word/vbaProject.bin": new Uint8Array(16) }), "factura.docx"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/macros/) });
    expect(validateOriginalAttachment(ole2("WordDocument", "Macros/VBA/_VBA_PROJECT"), "factura.doc"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/macros/) });
  });

  it("en un .doc o un .xls, las macros se buscan en el directorio y sin distinguir mayúsculas, como hace Office", () => {
    const macros = { ok: false, reason: expect.stringMatching(/macros/) };
    // Office abre igual un flujo «_vba_project» (MS-CFB compara sin mayúsculas).
    expect(validateOriginalAttachment(ole2("WordDocument", "_vba_project"), "factura.doc")).toMatchObject(macros);
    // Sin el flujo _VBA_PROJECT, pero con la carpeta de las macros.
    expect(validateOriginalAttachment(ole2("WordDocument", "Macros/VBA/dir", "Macros/PROJECT"), "factura.doc")).toMatchObject(macros);
    expect(validateOriginalAttachment(ole2("WordDocument", "macros/vba/dir"), "factura.doc")).toMatchObject(macros);
    expect(validateOriginalAttachment(ole2("Workbook", "_vba_project_cur/VBA/dir"), "libro.xls")).toMatchObject(macros);
    // Macros de Excel 4.0 (XLM) y módulos de VBA en la lista de hojas del libro.
    expect(validateOriginalAttachment(ole2(["Workbook", biff(1)]), "libro.xls")).toMatchObject(macros);
    expect(validateOriginalAttachment(ole2(["Workbook", biff(6)]), "libro.xls")).toMatchObject(macros);
    expect(validateOriginalAttachment(ole2(["Workbook", biff(0)]), "libro.xls")).toMatchObject({ ok: true, kind: "xls" });
  });

  it("un OLE2 es Word o Excel por las entradas de su directorio, no por bytes sueltos", () => {
    // «WordDocument» escrito dentro de otro flujo no lo hace un .doc.
    expect(validateOriginalAttachment(ole2(["1Table", utf16le("WordDocument")]), "factura.doc"))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/ni Word ni Excel/) });
    // Ni en una subcarpeta.
    expect(validateOriginalAttachment(ole2("ObjectPool/WordDocument"), "factura.doc")).toMatchObject({ ok: false });
    // La firma de OLE2 con lo demás roto, tampoco.
    const broken = ole2("WordDocument");
    broken.fill(0x55, 8, 64);
    expect(validateOriginalAttachment(broken, "factura.doc")).toMatchObject({ ok: false, reason: expect.stringMatching(/dañado/) });
  });

  it("un .odt o un .ods con macros Basic o scripts no se admite; los índices vacíos de las bibliotecas, sí", () => {
    const text = "application/vnd.oasis.opendocument.text";
    const macros = { ok: false, reason: expect.stringMatching(/macros/) };
    const basic = strToU8('<script:module script:name="Module1">Sub Main\nShell("calc")\nEnd Sub</script:module>');
    expect(validateOriginalAttachment(odf(text, { "Basic/Standard/Module1.xml": basic, "Basic/script-lc.xml": strToU8("<x/>") }), "f.odt"))
      .toMatchObject(macros);
    expect(validateOriginalAttachment(odf(text, { "basic/standard/module1.xml": basic }), "f.odt")).toMatchObject(macros);
    expect(validateOriginalAttachment(odf("application/vnd.oasis.opendocument.spreadsheet", { "Scripts/python/x.py": strToU8("import os") }), "f.ods"))
      .toMatchObject(macros);
    expect(validateOriginalAttachment(odf(text, { "Basic/script-lc.xml": strToU8("<x/>"), "Basic/Standard/script-lb.xml": strToU8("<x/>") }), "f.odt"))
      .toMatchObject({ ok: true, kind: "odt" });
  });

  it("rechaza un ZIP disfrazado: sin [Content_Types].xml, con otro programa de Office o con el mimetype de otra cosa", () => {
    const plainZip = zipSync({ "factura.pdf": PDF });
    expect(validateOriginalAttachment(plainZip, "factura.docx")).toMatchObject({ ok: false, reason: expect.stringMatching(/ZIP/) });
    const pptx = ooxml("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
    expect(validateOriginalAttachment(pptx, "factura.docx")).toMatchObject({ ok: false });
    // El mimetype de ODF tiene que ir la primera entrada.
    const misplaced = zipSync({ "content.xml": strToU8("<x/>"), mimetype: strToU8("application/vnd.oasis.opendocument.text") });
    expect(validateOriginalAttachment(misplaced, "f.odt")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(odf("application/vnd.oasis.opendocument.presentation"), "f.odt")).toMatchObject({ ok: false });
    // Un ZIP roto no revienta: se rechaza.
    expect(validateOriginalAttachment(padTo(bytes(0x50, 0x4b, 0x03, 0x04), 64), "f.docx")).toMatchObject({ ok: false });
  });

  it("exige la extensión del contenido", () => {
    expect(validateOriginalAttachment(ole2("Workbook"), "factura.doc")).toMatchObject({ ok: false, reason: expect.stringMatching(/\.xls/) });
    expect(validateOriginalAttachment(ole2("WordDocument"), "factura.xls")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(realXlsx(), "factura.docx")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(odf("application/vnd.oasis.opendocument.text"), "f.ods")).toMatchObject({ ok: false });
    expect(validateOriginalAttachment(RTF, "factura.doc")).toMatchObject({ ok: false });
    // Un OLE2 que no es ni Word ni Excel (un .msi, un .ppt).
    expect(validateOriginalAttachment(ole2("PowerPoint Document"), "f.doc")).toMatchObject({ ok: false });
  });

  it("vacío o de más de 20 MB, no", () => {
    expect(validateOriginalAttachment(new Uint8Array(0), "f.rtf")).toMatchObject({ ok: false });
    const big = new Uint8Array(ORIGINAL_ATTACHMENT_MAX_BYTES + 1);
    big.set(RTF);
    expect(validateOriginalAttachment(big, "f.rtf")).toMatchObject({ ok: false, reason: expect.stringMatching(/20 MB/) });
  });

  it("validateUploadedFile sigue rechazando un Word o un Excel como fichero de una factura", () => {
    expect(validateUploadedFile({ buffer: ole2("WordDocument"), filename: "factura.doc" }).ok).toBe(false);
    expect(validateUploadedFile({ buffer: ooxml(DOCX_MAIN), filename: "factura.docx" }).ok).toBe(false);
    expect(validateUploadedFile({ buffer: realXlsx(), filename: "libro.xlsx" }).ok).toBe(false);
  });
});
