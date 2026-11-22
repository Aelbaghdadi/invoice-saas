/**
 * La lista de ficheros del formulario de subida del gestor (5.2), sin React:
 * qué entra y qué se avisa al añadir, el orden y la «Pág. N» de cada fila,
 * las tandas que hay que abrir al pulsar «Subir» y lo que deja cada subida.
 * Los File se quedan en el hook (un Map por id); aquí van sus datos. Cada
 * función devuelve un estado nuevo y no toca el que recibe.
 *
 * Una fila «sin tanda» aún no se ha mandado: es la que se ordena, se mueve y
 * se numera. Las que ya tienen tanda conservan su tanda y su posición hasta
 * que suben (un reintento va a la misma página del mismo taco).
 */
import { tacoLabel } from "@/lib/paperLocation";
import {
  isOfficeFileName,
  sortByUploadName,
  sortByUploadTime,
  uploadFileExtension,
} from "@/lib/uploadOrder";

export const UPLOAD_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Ficheros por tanda: el mismo tope que UPLOAD_BATCH_MAX_FILES de uploadBatches.ts. */
export const UPLOAD_LIST_BLOCK_SIZE = 500;

export type UploadListMode = "digital" | "perInvoice" | "wholePdf";
export type UploadSortBy = "name" | "time";

export type UploadListItem = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  /** File.type, si el navegador lo da: un fichero sin extensión también se reconoce. */
  mimeType?: string;
  status: "queued" | "uploading" | "ok" | "duplicate" | "error";
  errorMessage?: string;
  errorCode?: string;
  duplicateOf?: string;
  batchId?: string;
  position?: number;
  tacoNumber?: number | null;
};

export type UploadListState = { items: UploadListItem[]; manualOrder: boolean; sortBy: UploadSortBy };

export const EMPTY_UPLOAD_LIST: UploadListState = { items: [], manualOrder: false, sortBy: "name" };

export type NewUploadFile = Omit<UploadListItem, "status">;

// ── Textos ──────────────────────────────────────────────────────────────────

export const OFFICE_FILES_NOTICE =
  "Los Word, Excel y similares no se suben aquí: sube el PDF de la factura y, en su ficha del archivo, «Adjuntar el original en Word, Excel…».";
export const XML_IN_PAPER_NOTICE = "Un XML no es un escaneo: súbelo sin marcar «Es papel».";
export const WHOLE_PDF_NOTICE = "En el taco entero va un solo PDF.";
export const TACO_MAX_FILES_ERROR = "Como mucho 500 ficheros por taco: pártelo en dos.";
/** ERR-UPLOAD-009 en una subida digital: allí la posición no es una página del papel. */
export const DIGITAL_SLOT_TAKEN_ERROR =
  "En su lugar de la subida ya entró otro fichero. Pulsa «Subir» otra vez: este irá en una subida nueva.";
const PAPER_SIZE_ADVICE_ONE = "Escanéalo en blanco y negro a 200 ppp o pártelo en dos.";
const PAPER_SIZE_ADVICE_MANY = "Escanéalos en blanco y negro a 200 ppp o pártelos en dos.";
const LOCK_TAIL = "reinténtalos o quítalos de la lista para cambiar el cliente, el lote o el tipo.";

function pendingTacoNotice(tacoNumber: number): string {
  return `Termina o quita los ficheros del ${tacoLabel(tacoNumber)} antes de añadir otros: irían a otro taco. Para añadirlos al mismo taco, usa «Completar el taco» en su detalle.`;
}

/** «34», «20,1»: en MB, redondeado hacia arriba a una décima para que algo
 *  que pasa de 20 no diga «20». */
function formatMegabytes(bytes: number): string {
  const tenths = Math.ceil((bytes * 10) / (1024 * 1024));
  const whole = Math.floor(tenths / 10);
  const decimal = tenths % 10;
  return decimal === 0 ? String(whole) : `${whole},${decimal}`;
}

/** «a.pdf», «a.pdf y b.pdf», «a.pdf, b.pdf y c.pdf», «a.pdf, b.pdf, c.pdf y 2 más». */
function listOf(names: readonly string[]): string {
  if (names.length <= 3) {
    return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(", ")} y ${names.length - 3} más`;
}

function acceptedTypesText(mode: UploadListMode): string {
  return mode === "digital" ? "PDF, JPG, PNG, WEBP, HEIC o XML" : "PDF, JPG, PNG, WEBP o HEIC";
}

// ── Qué entra ───────────────────────────────────────────────────────────────

// Los mismos que aceptaba el formulario: por la extensión o por el tipo que da el navegador.
const ACCEPTED_EXTENSIONS = new Set(["pdf", "xml", "jpg", "jpeg", "png", "webp", "heic"]);
const ACCEPTED_MIME_TYPES = new Set([
  "application/pdf", "text/xml", "application/xml",
  "image/jpeg", "image/png", "image/webp", "image/heic",
]);
const XML_MIME_TYPES = new Set(["text/xml", "application/xml"]);

type FileFacts = { name: string; size: number; mimeType?: string };

type RejectReason = "office" | "unsupported" | "empty" | "tooBig" | "xmlInPaper" | "notWholePdf";

function isXmlFile(file: FileFacts): boolean {
  return uploadFileExtension(file.name) === "xml" || XML_MIME_TYPES.has(file.mimeType ?? "");
}

function isPdfFile(file: FileFacts): boolean {
  return uploadFileExtension(file.name) === "pdf" || file.mimeType === "application/pdf";
}

function rejectReason(file: FileFacts, mode: UploadListMode): RejectReason | null {
  if (isOfficeFileName(file.name)) return "office";
  if (mode === "wholePdf" && !isPdfFile(file)) return "notWholePdf";
  if (!ACCEPTED_EXTENSIONS.has(uploadFileExtension(file.name)) && !ACCEPTED_MIME_TYPES.has(file.mimeType ?? "")) {
    return "unsupported";
  }
  if (file.size <= 0) return "empty";
  if (file.size > UPLOAD_MAX_FILE_BYTES) return "tooBig";
  if (mode === "perInvoice" && isXmlFile(file)) return "xmlInPaper";
  return null;
}

function noticeFor(reason: RejectReason, files: readonly FileFacts[], mode: UploadListMode): string {
  const one = files.length === 1;
  const names = files.map((file) => file.name);
  const paper = mode !== "digital";
  switch (reason) {
    case "office":
      return OFFICE_FILES_NOTICE;
    case "xmlInPaper":
      return XML_IN_PAPER_NOTICE;
    case "notWholePdf":
      return WHOLE_PDF_NOTICE;
    case "unsupported":
      return one
        ? `${names[0]} no se puede subir: solo se admiten ${acceptedTypesText(mode)}.`
        : `${files.length} ficheros no se pueden subir (${listOf(names)}): solo se admiten ${acceptedTypesText(mode)}.`;
    case "empty":
      return one ? `${names[0]} está vacío.` : `${files.length} ficheros están vacíos (${listOf(names)}).`;
    case "tooBig": {
      if (one) {
        const text = `${names[0]} pesa ${formatMegabytes(files[0].size)} MB y el máximo es 20 MB.`;
        return paper ? `${text} ${PAPER_SIZE_ADVICE_ONE}` : text;
      }
      const sized = files.map((file) => `${file.name} (${formatMegabytes(file.size)} MB)`);
      const text = `${files.length} ficheros pesan más de 20 MB, el máximo: ${listOf(sized)}.`;
      return paper ? `${text} ${PAPER_SIZE_ADVICE_MANY}` : text;
    }
  }
}

/** Por qué no entra un fichero en la lista, o null si entra. Para «Cambiar el
 *  fichero», que lo mira antes de replaceFile. */
export function uploadFileNotice(file: FileFacts, mode: UploadListMode): string | null {
  const reason = rejectReason(file, mode);
  return reason ? noticeFor(reason, [file], mode) : null;
}

// ── Orden y páginas ─────────────────────────────────────────────────────────

const isDone = (item: UploadListItem) => item.status === "ok" || item.status === "duplicate";

/** Sin tanda, sin subir y sin subida en curso: se ordena, se mueve y se numera. */
function isMovable(item: UploadListItem): boolean {
  return !item.batchId && (item.status === "queued" || item.status === "error");
}

/** Con tanda y aún sin subir (o subiéndose). */
function isPendingInBatch(item: UploadListItem): boolean {
  return !!item.batchId && !isDone(item);
}

function sortRows(rows: readonly UploadListItem[], sortBy: UploadSortBy): UploadListItem[] {
  return sortBy === "time"
    ? sortByUploadTime(rows, (row) => row.lastModified, (row) => row.name)
    : sortByUploadName(rows, (row) => row.name);
}

/** Pone `ordered` en los huecos de las filas que se mueven, sin mover las
 *  demás; lo que sobra, al final. */
function withMovableOrder(items: readonly UploadListItem[], ordered: readonly UploadListItem[]): UploadListItem[] {
  let next = 0;
  const result = items.map((item) => (isMovable(item) ? ordered[next++] : item));
  return [...result, ...ordered.slice(next)];
}

/** Añade lo que vale (sin repetir nombre y tamaño), ordenado según B-R7, y devuelve los avisos de lo que no entra:
 *  Office, más de 20 MB, XML en papel, más de un fichero o no PDF en el taco entero, o un taco pendiente (5.2).
 *  Lo que no es PDF, imagen ni XML tampoco entra, también con su aviso. */
export function addToUploadList(
  state: UploadListState,
  files: readonly NewUploadFile[],
  mode: UploadListMode,
): { state: UploadListState; notices: string[] } {
  if (files.length === 0) return { state, notices: [] };

  // Con un taco empezado a medias, lo nuevo iría a otro taco y el montón quedaría partido.
  const pendingTaco = state.items.find((item) => isPendingInBatch(item) && item.tacoNumber != null);
  if (pendingTaco?.tacoNumber != null) return { state, notices: [pendingTacoNotice(pendingTaco.tacoNumber)] };

  const rejected = new Map<RejectReason, FileFacts[]>();
  const seen = new Set(state.items.map((item) => `${item.name}::${item.size}`));
  const ids = new Set(state.items.map((item) => item.id));
  let wholePdfTaken = mode === "wholePdf" && state.items.some((item) => !isDone(item));
  const accepted: UploadListItem[] = [];

  for (const file of files) {
    let reason = rejectReason(file, mode);
    const key = `${file.name}::${file.size}`;
    if (!reason && (seen.has(key) || ids.has(file.id))) continue;
    if (!reason && mode === "wholePdf" && wholePdfTaken) reason = "notWholePdf";
    if (reason) {
      rejected.set(reason, [...(rejected.get(reason) ?? []), file]);
      continue;
    }
    seen.add(key);
    ids.add(file.id);
    if (mode === "wholePdf") wholePdfTaken = true;
    accepted.push({
      id: file.id,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      status: "queued",
    });
  }

  const order: RejectReason[] = ["office", "unsupported", "empty", "tooBig", "xmlInPaper", "notWholePdf"];
  const notices = order.flatMap((reason) => {
    const list = rejected.get(reason);
    return list ? [noticeFor(reason, list, mode)] : [];
  });
  if (accepted.length === 0) return { state, notices };

  const movable = state.items.filter(isMovable);
  // Con filas movidas a mano, lo de antes se queda como está y lo nuevo va al final.
  const ordered = state.manualOrder
    ? [...movable, ...sortRows(accepted, state.sortBy)]
    : sortRows([...movable, ...accepted], state.sortBy);
  return { state: { ...state, items: withMovableOrder(state.items, ordered) }, notices };
}

export function removeFromUploadList(state: UploadListState, id: string): UploadListState {
  const target = state.items.find((item) => item.id === id);
  if (!target || target.status === "uploading") return state;
  const items = state.items.filter((item) => item.id !== id);
  return { ...state, items, manualOrder: items.length > 0 && state.manualOrder };
}

/** Solo filas sin tanda y sin subida en curso; page 1..n de las que no tienen tanda. Marca manualOrder. */
export function moveToPage(state: UploadListState, id: string, page: number): UploadListState {
  const movable = state.items.filter(isMovable);
  const from = movable.findIndex((item) => item.id === id);
  if (from < 0 || !Number.isInteger(page) || page < 1 || page > movable.length || page - 1 === from) return state;
  const reordered = [...movable];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(page - 1, 0, moved);
  return { ...state, items: withMovableOrder(state.items, reordered), manualOrder: true };
}

/** «Subir una fila» (-1) o «Bajar una fila» (1). En el extremo, igual. */
export function moveByOne(state: UploadListState, id: string, delta: -1 | 1): UploadListState {
  const page = pageOf(state, id);
  const target = state.items.find((item) => item.id === id);
  if (page == null || !target || !isMovable(target)) return state;
  return moveToPage(state, id, page + delta);
}

/** Vuelve a ordenar lo que no tiene tanda y quita el orden a mano. */
export function resortUploadList(state: UploadListState, sortBy: UploadSortBy): UploadListState {
  const ordered = sortRows(state.items.filter(isMovable), sortBy);
  return { items: withMovableOrder(state.items, ordered), manualOrder: false, sortBy };
}

/** «Pág. N» de cada fila: la que tiene o la que tendrá. */
export function pageOf(state: UploadListState, id: string): number | null {
  const item = state.items.find((row) => row.id === id);
  if (!item) return null;
  if (item.batchId) return item.position ?? null;
  if (!isMovable(item)) return null;
  return state.items.filter(isMovable).findIndex((row) => row.id === id) + 1;
}

/** Bloques que necesitan tanda nueva, en el orden visible: digital en bloques de 500; factura a factura, uno (o
 *  { error: «Como mucho 500 ficheros por taco: pártelo en dos.» }); taco entero, ninguno (va con wholeTaco).
 *  Si la lista no casa con el modo (se cambió después de añadir), el aviso de lo que sobra. */
export function planNewBatches(state: UploadListState, mode: UploadListMode): { blocks: string[][] } | { error: string } {
  const movable = state.items.filter(isMovable);
  if (mode === "wholePdf") {
    const waiting = state.items.filter((item) => !item.batchId && !isDone(item));
    if (waiting.length > 1 || waiting.some((item) => !isPdfFile(item))) return { error: WHOLE_PDF_NOTICE };
    return { blocks: [] };
  }
  if (movable.length === 0) return { blocks: [] };
  const ids = movable.map((item) => item.id);
  if (mode === "perInvoice") {
    if (movable.some(isXmlFile)) return { error: XML_IN_PAPER_NOTICE };
    if (ids.length > UPLOAD_LIST_BLOCK_SIZE) return { error: TACO_MAX_FILES_ERROR };
    return { blocks: [ids] };
  }
  const blocks: string[][] = [];
  for (let start = 0; start < ids.length; start += UPLOAD_LIST_BLOCK_SIZE) {
    blocks.push(ids.slice(start, start + UPLOAD_LIST_BLOCK_SIZE));
  }
  return { blocks };
}

/** La tanda recién abierta para esas filas: posiciones 1..n en el orden visible. */
export function assignBatch(
  state: UploadListState,
  ids: readonly string[],
  batch: { id: string; tacoNumber: number | null },
): UploadListState {
  const wanted = new Set(ids);
  let position = 0;
  const items = state.items.map((item) => {
    if (!wanted.has(item.id) || item.batchId) return item;
    position += 1;
    return { ...item, batchId: batch.id, tacoNumber: batch.tacoNumber, position };
  });
  return position === 0 ? state : { ...state, items };
}

/** La fila se está subiendo (el hook lo marca al empezar cada una). */
export function markUploading(state: UploadListState, id: string): UploadListState {
  return updateItem(state, id, (item) => ({
    ...item,
    status: "uploading",
    errorMessage: undefined,
    errorCode: undefined,
    duplicateOf: undefined,
  }));
}

/** Resultado de una subida; con ERR-UPLOAD-008, o con ERR-UPLOAD-009 en una subida digital, quita la tanda y la
 *  posición de esa fila. */
export function applyUploadResult(
  state: UploadListState,
  id: string,
  result: { status: "ok" | "duplicate" | "error"; message?: string; code?: string; of?: string },
): UploadListState {
  return updateItem(state, id, (item) => {
    const clean = { ...item, errorMessage: undefined, errorCode: undefined, duplicateOf: undefined };
    if (result.status === "ok") return { ...clean, status: "ok" };
    if (result.status === "duplicate") return { ...clean, status: "duplicate", duplicateOf: result.of };
    const failed: UploadListItem = {
      ...clean,
      status: "error",
      errorMessage: result.message ?? "No se ha podido subir el fichero.",
      errorCode: result.code,
    };
    const withoutBatch = { batchId: undefined, position: undefined, tacoNumber: undefined };
    // La tanda ya no vale (caducada, anulada…): el siguiente «Subir» abre otra.
    if (result.code === "ERR-UPLOAD-008") return { ...failed, ...withoutBatch };
    // En una subida digital su posición la ocupa otro fichero (un primer
    // intento que sí llegó, y después «Cambiar el fichero»). Sin taco no hay
    // página que respetar: en la misma tanda daría 009 en cada reintento.
    if (result.code === "ERR-UPLOAD-009" && item.batchId && item.tacoNumber == null) {
      return { ...failed, errorMessage: DIGITAL_SLOT_TAKEN_ERROR, ...withoutBatch };
    }
    return failed;
  });
}

/** Cambia el fichero de una fila con error y conserva su tanda y su página («Cambiar el fichero»).
 *  Si el fichero nuevo no vale para esa fila (uploadFileNotice), no cambia nada. */
export function replaceFile(
  state: UploadListState,
  id: string,
  file: Omit<UploadListItem, "status" | "id">,
): UploadListState {
  const item = state.items.find((row) => row.id === id);
  if (!item || item.status !== "error") return state;
  const mode: UploadListMode = item.tacoNumber != null ? "perInvoice" : "digital";
  if (uploadFileNotice(file, mode)) return state;
  return updateItem(state, id, (row) => ({
    ...row,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: file.mimeType,
    status: "queued",
    errorMessage: undefined,
    errorCode: undefined,
    duplicateOf: undefined,
  }));
}

/** Quita lo subido y lo duplicado (la autolimpieza de después de subir). */
export function clearFinishedUploads(state: UploadListState): UploadListState {
  const items = state.items.filter((item) => !isDone(item));
  if (items.length === state.items.length) return state;
  return { ...state, items, manualOrder: items.length > 0 && state.manualOrder };
}

/** Texto del bloqueo de cliente, lote, tipo y papel con ficheros pendientes de una tanda (5.2), o null. */
export function settingsLockReason(state: UploadListState): string | null {
  const pending = state.items.filter(isPendingInBatch);
  if (pending.length === 0) return null;
  const taco = pending.find((item) => item.tacoNumber != null);
  return taco?.tacoNumber != null
    ? `Hay ficheros del ${tacoLabel(taco.tacoNumber)} sin subir: ${LOCK_TAIL}`
    : `Hay ficheros de esta subida sin subir: ${LOCK_TAIL}`;
}

/** ¿Hay subidas en curso? (para el aviso de beforeunload). */
export function isUploading(state: UploadListState): boolean {
  return state.items.some((item) => item.status === "uploading");
}

function updateItem(
  state: UploadListState,
  id: string,
  change: (item: UploadListItem) => UploadListItem,
): UploadListState {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const items = [...state.items];
  items[index] = change(items[index]);
  return { ...state, items };
}
