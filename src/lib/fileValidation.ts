/**
 * Validacion de magic bytes para uploads.
 *
 * Motivo: no podemos confiar en file.type (lo pone el browser) ni en la
 * extension (es texto libre). Leemos los primeros bytes del fichero y
 * comparamos con las firmas conocidas. Si no matchea, se rechaza.
 */
import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";

export type AllowedFileKind = "pdf" | "jpeg" | "png" | "webp" | "xml" | "heic";

const SIGNATURES: Record<AllowedFileKind, (buf: Uint8Array) => boolean> = {
  // %PDF-
  pdf: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d,
  // FFD8FF (JFIF / Exif / etc)
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // 89 50 4E 47 0D 0A 1A 0A
  png: (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  // RIFF....WEBP
  webp: (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  // ISO BMFF: ftyp box at byte 4. HEIC → ftypheic / ftypheix / ftypmif1 / ftypmsf1
  heic: (b) => {
    if (b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return false;
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return ["heic", "heix", "mif1", "msf1", "heim", "heis", "hevc", "hevx"].includes(brand);
  },
  // XML: acepta BOM + "<?xml" o directamente "<"
  xml: (b) => {
    // Skip UTF-8 BOM si existe
    let i = 0;
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    // <?xml
    if (
      b[i] === 0x3c && b[i + 1] === 0x3f && b[i + 2] === 0x78 &&
      b[i + 3] === 0x6d && b[i + 4] === 0x6c
    ) return true;
    // Facturae empieza a veces directo con <fe: o <FacturaE>; aceptamos "<" + caracter ASCII imprimible
    if (b[i] === 0x3c && b[i + 1] >= 0x20 && b[i + 1] <= 0x7e) return true;
    return false;
  },
};

/**
 * Detecta el tipo real del fichero inspeccionando los primeros bytes.
 * Devuelve null si no es ninguno de los permitidos.
 */
export function detectFileKind(buffer: ArrayBuffer | Uint8Array): AllowedFileKind | null {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b.length < 12) return null;
  for (const kind of Object.keys(SIGNATURES) as AllowedFileKind[]) {
    if (SIGNATURES[kind](b)) return kind;
  }
  return null;
}

/**
 * Valida coherencia entre magic bytes y la extension/MIME declarada.
 * Devuelve {ok:true,kind} o {ok:false,reason}.
 */
export function validateUploadedFile(params: {
  buffer: ArrayBuffer | Uint8Array;
  filename: string;
  declaredMime?: string;
}): { ok: true; kind: AllowedFileKind } | { ok: false; reason: string } {
  const kind = detectFileKind(params.buffer);
  if (!kind) {
    return { ok: false, reason: "Tipo de archivo no reconocido o corrupto" };
  }
  // Coherencia extension
  const ext = params.filename.split(".").pop()?.toLowerCase() ?? "";
  const EXT_MAP: Record<AllowedFileKind, string[]> = {
    pdf: ["pdf"],
    jpeg: ["jpg", "jpeg"],
    png: ["png"],
    webp: ["webp"],
    heic: ["heic", "heif"],
    xml: ["xml"],
  };
  if (ext && !EXT_MAP[kind].includes(ext)) {
    return {
      ok: false,
      reason: `Extension .${ext} no coincide con el contenido (${kind})`,
    };
  }
  return { ok: true, kind };
}

/** MIME canonico para cada kind (usado al subir a storage). */
export function canonicalMime(kind: AllowedFileKind): string {
  switch (kind) {
    case "pdf":  return "application/pdf";
    case "jpeg": return "image/jpeg";
    case "png":  return "image/png";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "xml":  return "application/xml";
  }
}

// ── Originales en otros formatos (R19) ──────────────────────────────────────
// Solo como original adjunto a una factura ya subida: la app lee su PDF. Nunca
// van al OCR ni al visor; se sirven como descarga.

export type OriginalAttachmentKind = "doc" | "xls" | "docx" | "xlsx" | "odt" | "ods" | "rtf";

/** Tope de un original adjunto, como el de una subida. */
export const ORIGINAL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const ORIGINAL_ATTACHMENT_MIME: Record<OriginalAttachmentKind, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
};

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const RTF_SIGNATURE = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf

/** Lo que se descomprime de un ZIP para mirarlo, como mucho: el resto ni se toca. */
const ZIP_PEEK_MAX_BYTES = 1024 * 1024;

const OOXML_MAIN_TYPES: Partial<Record<OriginalAttachmentKind, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
};

const ODF_MIMETYPES: Partial<Record<OriginalAttachmentKind, string>> = {
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

const startsWith = (b: Uint8Array, signature: number[]) => signature.every((byte, i) => b[i] === byte);

const MACROS_REASON = "Lleva macros, y los documentos con macros no se admiten.";

/** Entradas de un OLE2 que solo lleva un documento con macros VBA: Macros y
 *  _VBA_PROJECT_CUR (las carpetas de Word y de Excel), VBA y _VBA_PROJECT. */
const OLE2_MACRO_ENTRIES = new Set(["MACROS", "_VBA_PROJECT_CUR", "VBA", "_VBA_PROJECT"]);
const CFB_STREAM = 2;

/** Lo que se usa del directorio que devuelve XLSX.CFB.read (xlsx no lo tipa). */
type CfbContainer = {
  FullPaths: string[];
  FileIndex: { name: string; type: number; content?: ArrayLike<number> | null }[];
};

/**
 * ¿Lleva el libro una hoja de macros de Excel 4.0 (XLM) o un módulo de VBA?
 * Se mira el tipo de cada hoja (registro BoundSheet, 0x0085: posición, 4
 * bytes; visibilidad, 1; tipo, 1) en la parte global del libro, que acaba en
 * el primer EOF (0x000A).
 */
function hasMacroSheet(workbook: ArrayLike<number>): boolean {
  for (let at = 0; at + 4 <= workbook.length; ) {
    const type = workbook[at] | (workbook[at + 1] << 8);
    const size = workbook[at + 2] | (workbook[at + 3] << 8);
    if (type === 0x000a) return false;
    if (type === 0x0085 && size >= 6 && (workbook[at + 9] === 0x01 || workbook[at + 9] === 0x06)) return true;
    at += 4 + size;
  }
  return false;
}

/**
 * Qué es un documento OLE2 por su directorio (no por bytes sueltos): Word
 * (.doc) si tiene el flujo WordDocument, Excel (.xls) si tiene Workbook o
 * Book. Los nombres se comparan sin mayúsculas, como hace Office (MS-CFB
 * 2.6.4). Con macros no se admite, como un .docm; tampoco otro OLE2 (un .msi
 * renombrado, por ejemplo).
 */
function ole2Kind(b: Uint8Array): { kind: OriginalAttachmentKind } | { reason: string } {
  let container: CfbContainer;
  try {
    container = XLSX.CFB.read(b, { type: "array" }) as CfbContainer;
  } catch {
    return { reason: "El fichero está dañado o no es un documento." };
  }
  const entries = container.FileIndex;
  if (entries.some((entry) => OLE2_MACRO_ENTRIES.has(entry.name.toUpperCase()))) return { reason: MACROS_REASON };
  // Los flujos del primer nivel, por su nombre en mayúsculas.
  const root = container.FullPaths[0];
  const streams = new Map(entries.flatMap((entry, i) =>
    entry.type === CFB_STREAM && container.FullPaths[i] === root + entry.name ? [[entry.name.toUpperCase(), entry] as const] : []));
  if (streams.has("WORDDOCUMENT")) return { kind: "doc" };
  const workbook = streams.get("WORKBOOK") ?? streams.get("BOOK");
  if (workbook) return hasMacroSheet(workbook.content ?? []) ? { reason: MACROS_REASON } : { kind: "xls" };
  return { reason: "Es un documento de Office antiguo que no es ni Word ni Excel." };
}

/** Macros de OpenDocument: Basic y scripts (Python, JavaScript…). Los índices
 *  de las bibliotecas (script-lc.xml, script-lb.xml) no llevan código. */
const ODF_MACRO_ENTRY = /^(basic|scripts)\//i;
const ODF_LIBRARY_INDEX = /(^|\/)script-l[bc]\.xml$/i;

/** Qué es un ZIP de Office u OpenDocument, mirando solo su índice y, como
 *  mucho, [Content_Types].xml o la entrada mimetype. */
function zipKind(b: Uint8Array): { kind: OriginalAttachmentKind } | { reason: string } {
  const names: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(b, {
      filter: (file) => {
        names.push(file.name);
        return (file.name === "[Content_Types].xml" || file.name === "mimetype")
          && file.size <= ZIP_PEEK_MAX_BYTES && file.originalSize <= ZIP_PEEK_MAX_BYTES;
      },
    });
  } catch {
    return { reason: "El fichero está dañado o no es un documento." };
  }
  if (names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) return { reason: MACROS_REASON };
  const contentTypes = entries["[Content_Types].xml"];
  if (contentTypes) {
    // Las partes que lleva de verdad (Override); los Default son por extensión
    // y van en cualquier fichero (Excel declara el .bin de las macros siempre).
    const parts = [...strFromU8(contentTypes).matchAll(/<Override\b[^>]*\bContentType="([^"]+)"/g)].map((m) => m[1]);
    if (parts.some((type) => /macroEnabled/i.test(type))) {
      return { reason: "Lleva macros (.docm o .xlsm), y los documentos con macros no se admiten." };
    }
    for (const [kind, type] of Object.entries(OOXML_MAIN_TYPES)) {
      if (parts.includes(type)) return { kind: kind as OriginalAttachmentKind };
    }
    return { reason: "Es un documento de Office que no es ni Word ni Excel." };
  }
  // En OpenDocument, «mimetype» es la primera entrada y va sin comprimir.
  const mimetype = names[0] === "mimetype" && entries.mimetype ? strFromU8(entries.mimetype).trim() : null;
  for (const [kind, type] of Object.entries(ODF_MIMETYPES)) {
    if (mimetype !== type) continue;
    const macros = names.some((name) => ODF_MACRO_ENTRY.test(name) && !name.endsWith("/") && !ODF_LIBRARY_INDEX.test(name));
    return macros ? { reason: MACROS_REASON } : { kind: kind as OriginalAttachmentKind };
  }
  return { reason: "Es un ZIP, no un documento de Word, Excel u OpenDocument." };
}

/**
 * ¿Vale como original adjunto (R19)? Por el contenido y no por el nombre: OLE2
 * (.doc y .xls, sin macros VBA ni XLM), ZIP con [Content_Types].xml (.docx y
 * .xlsx; nunca .docm ni .xlsm), ZIP con la entrada mimetype de OpenDocument
 * (.odt y .ods, sin macros Basic ni scripts) o «{\rtf» (.rtf). La extensión tiene que ser la del contenido. Hasta 20 MB.
 * validateUploadedFile sigue sin admitir nada de esto como fichero de una
 * factura.
 */
export function validateOriginalAttachment(
  buffer: ArrayBuffer | Uint8Array,
  filename: string,
): { ok: true; kind: OriginalAttachmentKind; mime: string } | { ok: false; reason: string } {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (b.length === 0) return { ok: false, reason: "El fichero está vacío." };
  if (b.length > ORIGINAL_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "Pasa de 20 MB." };
  const ext = /\.([^.\\/]+)$/.exec(filename.trim())?.[1]?.toLowerCase() ?? "";
  if (ext === "docm" || ext === "xlsm") return { ok: false, reason: "Los documentos con macros (.docm, .xlsm) no se admiten." };

  const detected = startsWith(b, OLE2_SIGNATURE)
    ? ole2Kind(b)
    : startsWith(b, ZIP_SIGNATURE)
      ? zipKind(b)
      : startsWith(b, RTF_SIGNATURE)
        ? { kind: "rtf" as const }
        : { reason: "El contenido no es el de un documento de Word, Excel, OpenDocument o RTF." };
  if ("reason" in detected) return { ok: false, reason: detected.reason };
  if (ext !== detected.kind) {
    return { ok: false, reason: `La extensión ${ext ? `.${ext}` : "(ninguna)"} no es la de su contenido (.${detected.kind}).` };
  }
  return { ok: true, kind: detected.kind, mime: ORIGINAL_ATTACHMENT_MIME[detected.kind] };
}
