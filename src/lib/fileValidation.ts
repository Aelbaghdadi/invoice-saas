/**
 * Validacion de magic bytes para uploads.
 *
 * Motivo: no podemos confiar en file.type (lo pone el browser) ni en la
 * extension (es texto libre). Leemos los primeros bytes del fichero y
 * comparamos con las firmas conocidas. Si no matchea, se rechaza.
 */

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
