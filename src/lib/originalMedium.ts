/**
 * Electrónico o papel: la propuesta automática (R10, con el anexo C2), quién
 * puede pisarla (R11) y las etiquetas que se ven. Módulo puro: lo usan el
 * análisis, la detección de los PDF antiguos y las pantallas del archivo.
 *
 * Un escaneo o una foto que llega fuera de un taco no se da por papel: puede
 * ser el original electrónico (un PDF escaneado que manda el proveedor por
 * correo, RD 1619/2012, art. 9) o la copia de un papel que guarda alguien.
 * Queda «Por confirmar» (medio null) hasta que lo diga el gestor.
 */
import type { OriginalMedium, OriginalMediumSource, RetentionHoldReason } from "@prisma/client";

/** Códigos de InvoiceArchive.originalMediumReason. */
export const ORIGINAL_MEDIUM_REASONS = [
  "xml",
  "pdf_text",
  "other_format",
  "taco",
  "scan_unconfirmed",
  "image_unconfirmed",
  "pdf_unreadable",
  "backfill_pending",
  "split",
  "manual",
] as const;
export type OriginalMediumReason = (typeof ORIGINAL_MEDIUM_REASONS)[number];

// ── Capa de texto y productor del PDF ───────────────────────────────────────

/** «Tiene capa de texto»: más de 100 caracteres sin contar espacios y como
 *  mucho un 2 % de caracteres rotos. Son los umbrales de isUsefulPdfText
 *  (ocrLlm.ts), que además exige un importe y un NIF: un PDF digital sin NIF
 *  también es electrónico. */
export const PDF_TEXT_MIN_CHARS = 100;
export const PDF_TEXT_MAX_BROKEN_RATIO = 0.02;
/** Caracteres que salen de una capa de texto rota: U+FFFD y uso privado. */
const BROKEN_CHAR_RE = /[\uFFFD\uE000-\uF8FF]/g;

export type PdfTextLayerStats = { chars: number; brokenRatio: number };

export function pdfTextLayerStats(text: string): PdfTextLayerStats {
  const compact = text.replace(/\s+/g, "");
  const broken = compact.match(BROKEN_CHAR_RE)?.length ?? 0;
  return { chars: compact.length, brokenRatio: compact.length > 0 ? broken / compact.length : 0 };
}

export function hasPdfTextLayer(stats: PdfTextLayerStats): boolean {
  return stats.chars > PDF_TEXT_MIN_CHARS && stats.brokenRatio <= PDF_TEXT_MAX_BROKEN_RATIO;
}

/**
 * Productor (o Creator) de un PDF hecho por un escáner, una multifunción o
 * una app de escanear. Un escaneo con OCR trae capa de texto: sin esta lista
 * saldría electrónico. Las marcas van solas porque no hacen PDF digitales;
 * los programas que sí los hacen (Acrobat, Word, Power PDF…) no entran.
 * Se guarda el productor de cada PDF (pdfProducer) para ir afinándola.
 */
export const SCANNER_PRODUCER_RE =
  /\b(?:canon|ricoh|scansnap|paperstream|xerox|konica|minolta|bizhub|kyocera|taskalfa|brother|epson|lexmark|toshiba|abbyy|camscanner|intsig|naps2|scanbot|turboscan|readiris|omnipage)\b|\bsharp\s+mx|\bhp\s*(?:scan|smart|digital\s+sending)\b|\badobe\s+(?:pdf\s+)?scan\b|\bpaper\s+capture\b|\b(?:microsoft|office)\s+lens\b|\bgenius\s+scan\b/i;

export function isScannerProducer(value: string | null | undefined): boolean {
  return !!value && SCANNER_PRODUCER_RE.test(value);
}

export const PDF_PRODUCER_MAX_LENGTH = 200;

// pdf.js devuelve Producer y Creator tal cual, con un NUL si lo lleva el PDF, y
// Postgres no admite NUL en un texto (22021): se perdía todo el análisis.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]+/g;

/** Producer o Creator como se guarda: sin caracteres de control ni espacios en
 *  los bordes, y como mucho PDF_PRODUCER_MAX_LENGTH. null si no queda nada. */
export function cleanPdfInfoText(value: string | null | undefined): string | null {
  const text = value?.replace(CONTROL_CHARS_RE, " ").trim();
  return text ? text.slice(0, PDF_PRODUCER_MAX_LENGTH) : null;
}

/** Lo que se ha leído de un PDF (extractPdfTextAndItems): el texto de las
 *  páginas que se leen y sus metadatos. failed: no se pudo abrir; timedOut:
 *  la lectura se cortó por tiempo. */
export type PdfReading = {
  text: string;
  producer?: string | null;
  creator?: string | null;
  failed?: boolean;
  timedOut?: boolean;
};

/** El productor que se guarda: el que delata al escáner si lo hay; si no,
 *  Producer y, en su defecto, Creator. */
function pdfProducerOf(pdf: PdfReading | null | undefined): string | null {
  const candidates = [pdf?.producer, pdf?.creator]
    .map(cleanPdfInfoText)
    .filter((value): value is string => value != null);
  return candidates.find((value) => isScannerProducer(value)) ?? candidates[0] ?? null;
}

// ── Propuesta (R10) ─────────────────────────────────────────────────────────

export type ArchiveFileKind = "xml" | "image" | "pdf";

/** Clase del fichero principal por su MIME. Lo que no es XML ni imagen se
 *  trata como PDF: la subida no admite otra cosa. */
export function archiveFileKind(fileType: string): ArchiveFileKind {
  if (/xml/i.test(fileType)) return "xml";
  if (/^image\//i.test(fileType)) return "image";
  return "pdf";
}

export type MediumProposalInput = {
  /** MIME del fichero principal (Invoice.fileType). */
  fileType: string;
  /** Tiene adjunto un original en otro formato (Word, Excel…). */
  hasOtherFormatOriginal?: boolean;
  /** Se subió en un taco (papel escaneado en la asesoría). */
  inTaco?: boolean;
  /** Solo en los PDF. Sin él, el PDF cuenta como no leído. */
  pdf?: PdfReading | null;
};

export type MediumProposal = {
  /** null = «Por confirmar». */
  medium: OriginalMedium | null;
  source: OriginalMediumSource;
  reason: OriginalMediumReason;
  pdfProducer: string | null;
};

/**
 * Propuesta de electrónico o papel, por orden: XML; original en otro formato
 * adjunto; taco; imagen; y en un PDF, el productor de escáner, la lectura
 * fallida o cortada y la capa de texto. Solo el taco da papel: un escaneo o
 * una foto fuera de un taco quedan «Por confirmar» con su motivo.
 * El productor de escáner va antes que la lectura cortada porque dice más:
 * es un escaneo aunque no se haya podido leer el texto.
 */
export function proposeOriginalMedium(input: MediumProposalInput): MediumProposal {
  const kind = archiveFileKind(input.fileType);
  const pdfProducer = kind === "pdf" ? pdfProducerOf(input.pdf) : null;
  const propose = (medium: OriginalMedium | null, source: OriginalMediumSource, reason: OriginalMediumReason) =>
    ({ medium, source, reason, pdfProducer });

  if (kind === "xml") return propose("ELECTRONIC", "AUTO", "xml");
  if (input.hasOtherFormatOriginal) return propose("ELECTRONIC", "MANUAL", "other_format");
  if (input.inTaco) return propose("PAPER", "TACO", "taco");
  if (kind === "image") return propose(null, "AUTO", "image_unconfirmed");

  const pdf = input.pdf;
  if (pdf && (isScannerProducer(pdf.producer) || isScannerProducer(pdf.creator))) {
    return propose(null, "AUTO", "scan_unconfirmed");
  }
  if (!pdf || pdf.failed || pdf.timedOut) return propose(null, "AUTO", "pdf_unreadable");
  if (hasPdfTextLayer(pdfTextLayerStats(pdf.text))) return propose("ELECTRONIC", "AUTO", "pdf_text");
  return propose(null, "AUTO", "scan_unconfirmed");
}

// ── Quién manda (R11) ───────────────────────────────────────────────────────

// Si el análisis puede escribir el medio de UNA factura (vacío o AUTO, y que
// no sea parte de una división) lo decide el WHERE de writeAutoMedium en
// archiveEdits.ts, en el mismo UPDATE: una función aparte aquí no protegería
// nada (otra escritura puede llegar entre la lectura y el UPDATE).

/** ¿Puede la propuesta de la raíz de una división llegar a sus partes? Solo
 *  si toda la familia (raíz y partes) está vacía o en automático. */
export function canAutoUpdateMediumFamily(
  rows: readonly { originalMediumSource: OriginalMediumSource | null }[],
): boolean {
  return rows.every((row) => row.originalMediumSource == null || row.originalMediumSource === "AUTO");
}

/** ¿Tiene sentido «Confirmar» el medio que hay? Solo si es Electrónico o
 *  Papel y no lo ha decidido ya una persona: confirmarlo lo deja igual pero
 *  con origen MANUAL, y un nuevo análisis ya no lo cambia. */
export function canConfirmMedium(medium: OriginalMedium | null, source: OriginalMediumSource | null): boolean {
  return medium != null && source !== "MANUAL";
}

// ── Etiquetas ───────────────────────────────────────────────────────────────

/** Etiqueta del medio; UNCONFIRMED es el medio null. */
export const MEDIUM_LABELS: Record<OriginalMedium | "UNCONFIRMED", string> = {
  ELECTRONIC: "Electrónico",
  PAPER: "Papel",
  UNCONFIRMED: "Por confirmar",
};

export function mediumLabel(medium: OriginalMedium | null | undefined): string {
  return MEDIUM_LABELS[medium ?? "UNCONFIRMED"];
}

export const MEDIUM_REASON_LABELS: Record<OriginalMediumReason, string> = {
  xml: "Factura electrónica en XML",
  pdf_text: "PDF con texto: no es un escaneo",
  other_format: "Hay un original en otro formato adjunto",
  taco: "Escaneado en un taco de la asesoría",
  scan_unconfirmed: "Escaneo: falta confirmar si hay papel",
  image_unconfirmed: "Foto: falta confirmar si hay papel",
  pdf_unreadable: "No se pudo leer el PDF",
  backfill_pending: "Pendiente de detectar",
  split: "Igual que el documento dividido del que sale",
  manual: "Puesto a mano",
};

/** Etiqueta de un motivo guardado; null si no hay motivo o no se conoce. */
export function mediumReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return (ORIGINAL_MEDIUM_REASONS as readonly string[]).includes(reason)
    ? MEDIUM_REASON_LABELS[reason as OriginalMediumReason]
    : null;
}

/**
 * El motivo de una parte de una división. Las que van «igual que el documento
 * dividido» (motivo split) enseñan el de su raíz, que es el que dice por qué
 * («Foto: falta confirmar si hay papel (todo el documento dividido)»). Sin el
 * de la raíz, el suyo.
 */
export function splitPartReasonLabel(partReason: string | null | undefined, rootReason: string | null | undefined): string | null {
  const root = partReason === "split" && rootReason !== "split" ? mediumReasonLabel(rootReason) : null;
  return root ? `${root} (todo el documento dividido)` : mediumReasonLabel(partReason);
}

export const MEDIUM_SOURCE_LABELS: Record<OriginalMediumSource, string> = {
  AUTO: "Automático",
  TACO: "Taco",
  MANUAL: "A mano",
};

export const RETENTION_HOLD_LABELS: Record<RetentionHoldReason, string> = {
  FIXED_ASSET: "Inmovilizado",
  TAX_CREDITS: "Bases negativas o deducciones pendientes",
  INSPECTION: "Inspección o pleito",
  OTHER: "Otro motivo",
};
