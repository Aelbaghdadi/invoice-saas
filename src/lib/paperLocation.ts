/**
 * Dónde está el papel de una factura (B-R12), si cuenta como «papel sin
 * ubicación» (B-R13), el estado de un taco y sus huecos página a página
 * (B-R18). Módulo puro: lo usan la tabla y la ficha del archivo, el buscador,
 * el índice del ZIP, el detalle y la hoja del taco y la auditoría.
 */
import type { InvoiceStatus, OriginalMedium, UploadBatchOrigin } from "@prisma/client";
import { boxLabelKey } from "@/lib/boxProposal";
import { formatDayEs } from "@/lib/dates";

export type TacoRef = {
  id: string;
  /** null: tanda digital. */
  tacoNumber: number | null;
  origin: UploadBatchOrigin;
  wholePdf: boolean;
  boxLabel: string | null;
  returnedAt: Date | null;
  filedAt: Date | null;
  voidedAt: Date | null;
};

export type PaperLocationInput = {
  medium: OriginalMedium | null;
  paperHeldByClient: boolean;
  uploadPosition: number | null;
  /** La tanda en la que llegó (uploadBatch). */
  arrival: TacoRef | null;
  /** El taco donde se puso su papel desde fuera (paperBatch). */
  paper: TacoRef | null;
};

export type PaperLocationKind = "electronic" | "client" | "box" | "returned" | "unfiled" | "voided" | "unconfirmed" | "none";

export type PaperLocation = {
  kind: PaperLocationKind;
  text: string;
  /** El taco donde está el papel (solo en box, returned, unfiled y voided). */
  tacoId: string | null;
  tacoNumber: number | null;
  /** «Pág.»: la posición en el taco de llegada (en un taco entero, la página del PDF donde empieza). */
  page: number | null;
  boxLabel: string | null;
  /** «Taco 37 · Pág. 12»; null en el papel ubicado a mano. */
  tacoText: string | null;
  /** «T37 · Pág. 12»; null en el papel ubicado a mano. */
  tacoShort: string | null;
  /** Papel en un taco ARCHIVE (ubicado a mano). */
  manual: boolean;
  /** B-R13: PAPER o «Por confirmar» sin ubicación (lo que se puede ubicar). */
  withoutLocation: boolean;
  /** Llegó en una tanda digital: para «Ver la subida». */
  arrivalDigitalBatchId: string | null;
};

/** «Taco 37». */
export function tacoLabel(n: number): string {
  return `Taco ${n}`;
}

/** «T37». */
export function tacoShortLabel(n: number): string {
  return `T${n}`;
}

function pageText(page: number, wholePdf: boolean): string {
  return wholePdf ? `Pág. ${page} del PDF` : `Pág. ${page}`;
}

/** El taco del papel: el que se puso a mano (paperBatch) o, si no hay, la
 *  tanda de llegada cuando es un taco (C1 de la entrega A). */
function paperTacoOf(input: PaperLocationInput): TacoRef | null {
  if (input.paper && input.paper.tacoNumber != null) return input.paper;
  return input.arrival && input.arrival.tacoNumber != null ? input.arrival : null;
}

function arrivalDigitalBatchIdOf(input: PaperLocationInput): string | null {
  const arrival = input.arrival;
  return arrival && arrival.tacoNumber == null && arrival.origin === "UPLOAD" ? arrival.id : null;
}

const RETURNED_PREFIX = "Devuelto al cliente el ";

export function paperLocationOf(input: PaperLocationInput): PaperLocation {
  const base: PaperLocation = {
    kind: "none",
    text: "",
    tacoId: null,
    tacoNumber: null,
    page: null,
    boxLabel: null,
    tacoText: null,
    tacoShort: null,
    manual: false,
    withoutLocation: false,
    arrivalDigitalBatchId: arrivalDigitalBatchIdOf(input),
  };

  if (input.medium === "ELECTRONIC") return { ...base, kind: "electronic", text: "Original electrónico" };
  if (input.paperHeldByClient) return { ...base, kind: "client", text: "Lo guarda el cliente" };

  const taco = paperTacoOf(input);
  if (taco && taco.origin === "ARCHIVE") {
    const located = { ...base, tacoId: taco.id, tacoNumber: taco.tacoNumber, manual: true };
    if (taco.boxLabel) {
      return { ...located, kind: "box", boxLabel: taco.boxLabel, text: `${taco.boxLabel} · papel ubicado a mano` };
    }
    // Sin «Taco N»: en la caja no hay nada marcado con su número.
    if (taco.returnedAt) return { ...located, kind: "returned", text: `${RETURNED_PREFIX}${formatDayEs(taco.returnedAt)}` };
    return { ...located, kind: "unfiled", text: "Papel ubicado a mano (sin guardar)" };
  }

  if (taco?.tacoNumber != null) {
    // La página es la posición en la tanda de llegada: en otro taco no tiene sentido.
    const page = taco.id === input.arrival?.id ? input.uploadPosition : null;
    const pagePart = page != null ? ` · ${pageText(page, taco.wholePdf)}` : "";
    const tacoText = `${tacoLabel(taco.tacoNumber)}${pagePart}`;
    const tacoShort = `${tacoShortLabel(taco.tacoNumber)}${pagePart}`;
    const located = { ...base, tacoId: taco.id, tacoNumber: taco.tacoNumber, page, tacoText, tacoShort };
    if (taco.voidedAt) return { ...located, kind: "voided", text: `${tacoText} (taco anulado)` };
    if (taco.boxLabel) return { ...located, kind: "box", boxLabel: taco.boxLabel, text: `${taco.boxLabel} · ${tacoText}` };
    if (taco.returnedAt) {
      return { ...located, kind: "returned", text: `${RETURNED_PREFIX}${formatDayEs(taco.returnedAt)} · ${tacoText}` };
    }
    return { ...located, kind: "unfiled", text: `${tacoText} (sin guardar)` };
  }

  if (input.medium == null) return { ...base, kind: "unconfirmed", text: "Por confirmar", withoutLocation: true };
  return { ...base, kind: "none", text: "Sin ubicación", withoutLocation: true };
}

/** La etiqueta sin «{cliente} · {ejercicio} · » si empieza por él (sin
 *  tildes ni mayúsculas). boxPrefix es el de B-R11 («… · 2026 · Caja »). */
function stripClientYear(label: string, boxPrefix: string | null): string {
  if (!boxPrefix) return label;
  const cut = boxPrefix.lastIndexOf(" · ");
  if (cut < 0) return label;
  const prefixParts = boxPrefix.slice(0, cut).split("·").map(boxLabelKey);
  const labelParts = label.split("·");
  if (labelParts.length <= prefixParts.length) return label;
  if (prefixParts.some((part, i) => boxLabelKey(labelParts[i]) !== part)) return label;
  return labelParts.slice(prefixParts.length).map((part) => part.trim()).join(" · ");
}

/**
 * ¿Busca este texto en la etiqueta de la caja? Todas sus palabras dentro de la
 * etiqueta (sin tildes ni mayúsculas, 3 caracteres o más en total) y alguna
 * con cifras o de 3 letras o más fuera de «{cliente} · {ejercicio} · » (boxPrefix,
 * el de B-R11). Con «una caja por cliente y año», el nombre del cliente o el
 * año solos casarían con todo su papel guardado y taparían lo que se busca.
 */
export function boxLabelMatchesWords(label: string, boxPrefix: string | null, text: string): boolean {
  const key = boxLabelKey(text);
  if (key.length < 3) return false;
  const words = key.split(" ").filter(Boolean);
  const whole = boxLabelKey(label);
  const own = boxLabelKey(stripClientYear(label, boxPrefix));
  return words.every((word) => whole.includes(word))
    && words.some((word) => (word.length >= 3 || /\d/.test(word)) && own.includes(word));
}

/** Forma corta para las tablas: sin el prefijo de B-R11 si la etiqueta empieza por él (sin tildes ni mayúsculas). */
export function shortPaperLocationText(location: PaperLocation, boxPrefix: string | null): string {
  const { kind, text, tacoText, tacoShort } = location;
  if (kind === "box" && location.boxLabel) {
    const box = stripClientYear(location.boxLabel, boxPrefix);
    const rest = location.manual ? "papel ubicado a mano" : tacoShort;
    return rest ? `${box} · ${rest}` : box;
  }
  if (!tacoText || !tacoShort) return text;
  if (kind === "returned" && text.endsWith(tacoText)) return `${text.slice(0, text.length - tacoText.length)}${tacoShort}`;
  if ((kind === "unfiled" || kind === "voided") && text.startsWith(tacoText)) return `${tacoShort}${text.slice(tacoText.length)}`;
  return text;
}

/** analyzing: espera su análisis o se está analizando (IN_ANALYSIS). */
type WithoutLocationInput = PaperLocationInput & { rejected?: boolean; analyzing?: boolean };

/** ¿Tiene taco? El papel puesto en uno (paperBatch) o una tanda de llegada con nº:
 *  lo mismo que mira paperLocationOf. */
function hasTaco(input: PaperLocationInput): boolean {
  return paperTacoOf(input) != null;
}

/** B-R13: medio PAPER, no rechazada, sin «lo guarda el cliente» y sin taco. El papel de un taco sin guardar no cuenta. */
export function isPaperWithoutLocation(input: WithoutLocationInput): boolean {
  return !input.rejected && input.medium === "PAPER" && !input.paperHeldByClient && !hasTaco(input);
}

/** B-R13: «Por confirmar» (medio null), no rechazada, sin «lo guarda el cliente» y sin taco. La que
 *  aún se analiza no: el análisis puede decir que es electrónica, y «Poner ubicación» la salta. */
export function isUnconfirmedWithoutLocation(input: WithoutLocationInput): boolean {
  return !input.rejected && !input.analyzing && input.medium == null && !input.paperHeldByClient && !hasTaco(input);
}

// ── Estado de un taco ───────────────────────────────────────────────────────

export type TacoState = "voided" | "pending-split" | "empty" | "unfiled" | "box" | "returned";

/** Anulado manda sobre todo; un taco entero sin dividir sigue «Por dividir»
 *  aunque se haya guardado; uno vacío que se guardó, en su caja. */
export function tacoState(b: {
  wholePdf: boolean;
  pdfSplitAt: Date | null;
  voidedAt: Date | null;
  filedAt: Date | null;
  boxLabel: string | null;
  returnedAt: Date | null;
  invoiceCount: number;
}): TacoState {
  if (b.voidedAt) return "voided";
  if (b.wholePdf && !b.pdfSplitAt) return "pending-split";
  if (b.boxLabel) return "box";
  if (b.returnedAt) return "returned";
  if (b.invoiceCount === 0) return "empty";
  return "unfiled";
}

/** «Anulado», «Por dividir», «Vacío», «Sin guardar», «En «Caja 3»», «Devuelto el 21/11/2026». */
export function tacoStateLabel(state: TacoState, b: { boxLabel: string | null; returnedAt: Date | null }): string {
  switch (state) {
    case "voided":
      return "Anulado";
    case "pending-split":
      return "Por dividir";
    case "empty":
      return "Vacío";
    case "unfiled":
      return "Sin guardar";
    case "box":
      return b.boxLabel ? `En «${b.boxLabel}»` : "En caja";
    case "returned":
      return b.returnedAt ? `Devuelto el ${formatDayEs(b.returnedAt)}` : "Devuelto";
  }
}

// ── Huecos del taco (B-R18) ─────────────────────────────────────────────────

/** Una factura que llegó en el taco (uploadBatchId = el taco). */
export type TacoSlotRow = {
  invoiceId: string;
  clientId: string;
  status: InvoiceStatus;
  splitFromId: string | null;
  uploadPosition: number | null;
  splitPart: number;
  medium: OriginalMedium | null;
  paperHeldByClient: boolean;
  paperBatchId: string | null;
  paperTacoNumber: number | null;
  paperTacoReturnedAt: Date | null;
  paperTacoOrigin: UploadBatchOrigin | null;
};

export type TacoSlotKind = "invoices" | "empty" | "electronic" | "client" | "elsewhere";

export type TacoSlot<T extends TacoSlotRow> = {
  page: number;
  endPage: number;
  /** Orden de la factura en un taco entero dividido (1.ª, 2.ª…); null en «sin factura» y en factura a factura. */
  order: number | null;
  kind: TacoSlotKind;
  rows: T[];
  /** El texto del hueco (B-R18) o «3 facturas en el mismo papel». */
  label: string | null;
};

const EMPTY_PER_INVOICE = "Sin factura (duplicada o no subida)";
const EMPTY_WHOLE_PDF = "Sin factura";

/** Por qué una fila no es papel de este taco, o null si lo es. */
function rowReason(row: TacoSlotRow, batchId: string): Exclude<TacoSlotKind, "invoices" | "empty"> | null {
  if (row.medium === "ELECTRONIC") return "electronic";
  if (row.paperHeldByClient) return "client";
  if (row.paperBatchId != null && row.paperBatchId !== batchId) return "elsewhere";
  return null;
}

function elsewhereLabel(row: TacoSlotRow): string {
  if (row.paperTacoOrigin === "ARCHIVE" && row.paperTacoReturnedAt) {
    return `Sacada: devuelta al cliente el ${formatDayEs(row.paperTacoReturnedAt)}`;
  }
  return row.paperTacoNumber != null ? `Guardada en el ${tacoLabel(row.paperTacoNumber)}` : "Guardada en otro taco";
}

function slotOf<T extends TacoSlotRow>(
  page: number,
  endPage: number,
  order: number | null,
  rows: T[],
  batchId: string,
  emptyLabel: string,
): TacoSlot<T> {
  if (rows.length === 0) return { page, endPage, order, kind: "empty", rows, label: emptyLabel };
  const reasons = rows.map((row) => rowReason(row, batchId));
  if (reasons.some((reason) => reason == null)) {
    return { page, endPage, order, kind: "invoices", rows, label: rows.length > 1 ? `${rows.length} facturas en el mismo papel` : null };
  }
  // Todas fuera: el motivo de la primera (las partes de una división comparten medio y papel).
  const kind = reasons[0] ?? "electronic";
  const label =
    kind === "electronic" ? "No es papel (original electrónico)"
    : kind === "client" ? "Lo guarda el cliente"
    : elsewhereLabel(rows[0]);
  return { page, endPage, order, kind, rows, label };
}

/**
 * Las páginas del taco con sus facturas (B-R18): factura a factura, cada
 * página de 1 a fileCount; en un taco entero ya dividido, cada rango, desde
 * la página donde empieza una factura hasta la anterior a la siguiente, y
 * antes del primero, «sin factura». La original de una división no se
 * enseña: salen sus partes, que comparten su página. Sin dividir, nada.
 */
export function tacoSlots<T extends TacoSlotRow>(input: {
  batchId: string;
  fileCount: number;
  wholePdf: boolean;
  pdfPageCount: number | null;
  split: boolean;
  rows: readonly T[];
}): TacoSlot<T>[] {
  if (input.wholePdf && !input.split) return [];

  const positioned = input.rows.filter(
    (row): row is T & { uploadPosition: number } =>
      row.uploadPosition != null && Number.isInteger(row.uploadPosition) && row.uploadPosition >= 1,
  );
  const partsOf = new Set(
    positioned.filter((row) => row.splitFromId != null).map((row) => `${row.splitFromId}|${row.uploadPosition}`),
  );
  const visible = positioned.filter(
    (row) => !(row.status === "SPLIT_SOURCE" && partsOf.has(`${row.invoiceId}|${row.uploadPosition}`)),
  );

  const byPage = new Map<number, T[]>();
  for (const row of visible) {
    const list = byPage.get(row.uploadPosition) ?? [];
    list.push(row);
    byPage.set(row.uploadPosition, list);
  }
  for (const list of byPage.values()) {
    list.sort((a, b) => a.splitPart - b.splitPart || (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0));
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : 0;

  if (!input.wholePdf) {
    // Hasta fileCount, o hasta la última fila si alguna quedara más allá: ninguna se pierde.
    const total = Math.max(input.fileCount, lastPage);
    return Array.from({ length: total }, (_, i) =>
      slotOf(i + 1, i + 1, null, byPage.get(i + 1) ?? [], input.batchId, EMPTY_PER_INVOICE),
    );
  }

  const pageCount = Math.max(input.pdfPageCount ?? 0, lastPage);
  const slots: TacoSlot<T>[] = [];
  if (pages.length === 0) {
    return pageCount > 0 ? [slotOf(1, pageCount, null, [], input.batchId, EMPTY_WHOLE_PDF)] : [];
  }
  if (pages[0] > 1) slots.push(slotOf(1, pages[0] - 1, null, [], input.batchId, EMPTY_WHOLE_PDF));
  pages.forEach((start, i) => {
    const end = i + 1 < pages.length ? pages[i + 1] - 1 : pageCount;
    slots.push(slotOf(start, end, i + 1, byPage.get(start) ?? [], input.batchId, EMPTY_WHOLE_PDF));
  });
  return slots;
}

/** «12» o «27-29». */
export function pageRangeLabel(page: number, endPage: number): string {
  return endPage > page ? `${page}-${endPage}` : String(page);
}

/** «12.ª». */
export function invoiceOrderLabel(order: number): string {
  return `${order}.ª`;
}
