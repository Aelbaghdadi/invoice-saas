/**
 * Orden de los ficheros al subirlos (B-R7): un taco de papel se numera en el
 * orden de la lista, así que la lista sigue el orden en que el escáner nombra
 * los ficheros («Scan (2)» antes que «Scan (10)»), o la hora de cada fichero.
 * Módulo puro: lo usan el formulario de subida y «Completar el taco».
 */

// Orden natural: los números se comparan como números, sin distinguir
// mayúsculas ni tildes.
const NAME_COLLATOR = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

/** Extensión en minúsculas, sin el punto; "" si no tiene. */
export function uploadFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orden natural del nombre, sin la extensión: «Scan» < «Scan (1)» < «Scan (2)» < «Scan (10)»;
 *  «SCAN0009» < «SCAN0010»; sin distinguir mayúsculas ni tildes (Intl.Collator("es", { numeric: true,
 *  sensitivity: "base" })); empate: la extensión y después el nombre entero por código. */
export function compareUploadNames(a: string, b: string): number {
  return (
    NAME_COLLATOR.compare(stemOf(a), stemOf(b)) ||
    NAME_COLLATOR.compare(uploadFileExtension(a), uploadFileExtension(b)) ||
    compareCodeUnits(a, b)
  );
}

/** Ordena por nombre (compareUploadNames) sin tocar la lista. Estable: dos
 *  nombres idénticos se quedan en el orden en que llegaron. */
export function sortByUploadName<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareUploadNames(nameOf(a.item), nameOf(b.item)) || a.index - b.index)
    .map(({ item }) => item);
}

/** Copia de la lista con el elemento de `from` puesto en `to` (índices desde
 *  0). Fuera de rango: la copia, igual. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  const inRange = (index: number) => Number.isInteger(index) && index >= 0 && index < copy.length;
  if (!inRange(from) || !inRange(to) || from === to) return copy;
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

const TACO_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png", "webp", "heic"]);

/** Ficheros que admite un taco por la extensión: pdf, jpg, jpeg, png, webp, heic (no xml). */
export function isTacoFileName(name: string): boolean {
  return TACO_EXTENSIONS.has(uploadFileExtension(name));
}

// Word, Excel, OpenDocument (texto y hoja) y RTF, con sus plantillas y las
// versiones con macros: se avisa en vez de ignorarlos sin más.
const OFFICE_EXTENSIONS = new Set([
  "doc", "docx", "docm", "dot", "dotx", "dotm",
  "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm",
  "odt", "ods", "ott", "ots",
  "rtf",
]);

/** Word, Excel, OpenDocument o RTF: lo que se avisa al soltarlo. */
export function isOfficeFileName(name: string): boolean {
  return OFFICE_EXTENSIONS.has(uploadFileExtension(name));
}

/** Por la hora del fichero (File.lastModified), y con la misma hora, por el nombre. */
export function sortByUploadTime<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  nameOf: (item: T) => string,
): T[] {
  // Una hora que no es un número va al final, para que el orden sea siempre el mismo.
  const time = (item: T) => {
    const value = timeOf(item);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => time(a.item) - time(b.item) || compareUploadNames(nameOf(a.item), nameOf(b.item)) || a.index - b.index)
    .map(({ item }) => item);
}
