/**
 * «Completar el taco» (5.7, B-R23), sin React ni BD: a qué página va cada
 * fichero que se suelta. Lo que ya está en el taco se reconoce por su huella
 * y no se sube; lo demás, en orden natural por nombre, va a las páginas
 * vacías si hay tantos como huecos y, si no, al final.
 */
import { sortByUploadName } from "@/lib/uploadOrder";

export type CompletionFile = { id: string; name: string; hash: string };

/** "end": al final del taco (la página la da extendTaco al subir). */
export type CompletionTarget = number | "end";

export type CompletionRow = {
  id: string;
  name: string;
  /** Ya está en el taco: su página. No se sube. */
  alreadyAt: number | null;
  /** El mismo fichero que otro de los que se sueltan: no se sube dos veces. */
  repeatOf: string | null;
  /** A dónde va; null si no se sube. */
  target: CompletionTarget | null;
};

/** Las páginas 1..fileCount sin ninguna factura. */
export function emptyTacoPages(fileCount: number, takenPages: readonly number[]): number[] {
  const taken = new Set(takenPages);
  return Array.from({ length: fileCount }, (_, i) => i + 1).filter((page) => !taken.has(page));
}

export function planTacoCompletion(input: {
  files: readonly CompletionFile[];
  /** Huella del fichero de cada página ya subida. */
  occupied: readonly { position: number; fileHash: string }[];
  takenPages: readonly number[];
  fileCount: number;
}): CompletionRow[] {
  const pageOfHash = new Map<string, number>();
  for (const page of [...input.occupied].sort((x, y) => x.position - y.position)) {
    const hash = page.fileHash.toLowerCase();
    if (!pageOfHash.has(hash)) pageOfHash.set(hash, page.position);
  }
  const seen = new Map<string, string>();
  const rows: CompletionRow[] = sortByUploadName(input.files, (file) => file.name).map((file) => {
    const hash = file.hash.toLowerCase();
    const alreadyAt = pageOfHash.get(hash) ?? null;
    const repeatOf = alreadyAt == null ? seen.get(hash) ?? null : null;
    if (alreadyAt == null && repeatOf == null) seen.set(hash, file.name);
    return { id: file.id, name: file.name, alreadyAt, repeatOf, target: null };
  });
  const toUpload = rows.filter((row) => row.alreadyAt == null && row.repeatOf == null);
  const empty = emptyTacoPages(input.fileCount, input.takenPages);
  const fill = toUpload.length > 0 && toUpload.length === empty.length;
  toUpload.forEach((row, i) => {
    row.target = fill ? empty[i] : "end";
  });
  return rows;
}

/** Dos ficheros a la misma página vacía. */
export function hasTargetClash(rows: readonly CompletionRow[]): boolean {
  const pages = rows.map((row) => row.target).filter((target): target is number => typeof target === "number");
  return new Set(pages).size !== pages.length;
}

/** Las páginas que tocan a los que van al final, en su orden, a partir de la primera nueva. */
export function endPositions(rows: readonly CompletionRow[], firstNewPosition: number): Map<string, number> {
  const positions = new Map<string, number>();
  let next = firstNewPosition;
  for (const row of rows) if (row.target === "end") positions.set(row.id, next++);
  return positions;
}

const files = (n: number) => `${n} ${n === 1 ? "fichero" : "ficheros"}`;

function pagesAtEnd(fileCount: number, count: number): string {
  return count === 1 ? `Pág. ${fileCount + 1}` : `Págs. ${fileCount + 1}-${fileCount + count}`;
}

/** «3 ficheros: 2 a páginas vacías y 1 al final del taco (Pág. 53).» */
export function completionSummary(rows: readonly CompletionRow[], fileCount: number): string {
  const toEmpty = rows.filter((row) => typeof row.target === "number").length;
  const toEnd = rows.filter((row) => row.target === "end").length;
  const already = rows.filter((row) => row.alreadyAt != null || row.repeatOf != null).length;
  const parts: string[] = [];
  if (toEmpty > 0 && toEnd > 0) {
    parts.push(`${files(toEmpty + toEnd)}: ${toEmpty} a ${toEmpty === 1 ? "una página vacía" : "páginas vacías"} y ${toEnd} al final del taco (${pagesAtEnd(fileCount, toEnd)}).`);
  } else if (toEmpty > 0) {
    parts.push(`${files(toEmpty)} a ${toEmpty === 1 ? "una página vacía" : "páginas vacías"}.`);
  } else if (toEnd > 0) {
    parts.push(`${files(toEnd)} al final del taco (${pagesAtEnd(fileCount, toEnd)}).`);
  }
  if (already > 0) parts.push(already === 1 ? "1 ya está en el taco." : `${already} ya están en el taco.`);
  return parts.join(" ");
}
