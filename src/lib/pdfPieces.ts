/**
 * Trozos de un PDF: cortarlo por rangos de páginas y subir los trozos al
 * almacenamiento. El taco entero (tacoSplit.ts) corta y sube con esto; la
 * división de la revisión y la automática (invoiceSplit.ts) suben con el
 * mismo uploadSplitPieces.
 */
import { PDFDocument } from "pdf-lib";
import { deleteObject, putObject } from "@/lib/storage";

/** Un trozo de una división, ya en memoria y listo para subir. */
export type SplitPiece = {
  label: string;
  filename: string;
  storageKey: string;
  fileType: string;
  body: Buffer;
};

/**
 * Sube los trozos, de `concurrency` en `concurrency` (1 por defecto: uno detrás
 * de otro). Si uno falla, no empieza ninguno más, espera a los que se estaban
 * subiendo y borra todos los subidos. Devuelve el error del primero que falló.
 */
export async function uploadSplitPieces(
  pieces: SplitPiece[],
  options: { concurrency?: number } = {},
): Promise<string | null> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const uploaded: string[] = [];
  const state: { failure: string | null; next: number } = { failure: null, next: 0 };
  const worker = async () => {
    while (state.failure === null && state.next < pieces.length) {
      const piece = pieces[state.next++];
      try {
        await putObject(piece.storageKey, piece.body, piece.fileType);
        uploaded.push(piece.storageKey);
      } catch (e) {
        state.failure ??= `Error subiendo "${piece.label}": ${e instanceof Error ? e.message : "fallo"}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pieces.length) }, worker));
  if (state.failure !== null) {
    await Promise.all(uploaded.map((key) => deleteObject(key)));
    return state.failure;
  }
  return null;
}

/** Abre un PDF con pdf-lib. Lanza si no se puede (dañado o con contraseña). */
export async function loadPdf(source: Buffer): Promise<PDFDocument> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  // pdf-lib abre sin error un PDF sin /Pages (o con /Pages roto) y es el
  // recuento lo que lanza.
  doc.getPageCount();
  return doc;
}

/**
 * PDFs nuevos con las páginas de cada rango (1-indexadas, las dos incluidas),
 * en el orden de los rangos. Lanza si el PDF no se lee o si un rango se sale.
 * Acepta el PDF ya abierto, para no leer dos veces uno de 500 páginas.
 */
export async function slicePdf(
  source: Buffer | PDFDocument,
  ranges: readonly { start: number; end: number }[],
): Promise<Buffer[]> {
  const doc = Buffer.isBuffer(source) ? await loadPdf(source) : source;
  const total = doc.getPageCount();
  const bodies: Buffer[] = [];
  for (const { start, end } of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > total || start > end) {
      throw new RangeError(`Páginas ${start}-${end} fuera del PDF (${total} páginas)`);
    }
    const piece = await PDFDocument.create();
    // copyPages devuelve las páginas en el mismo orden que los índices.
    const pages = await piece.copyPages(doc, Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i));
    for (const page of pages) piece.addPage(page);
    bodies.push(Buffer.from(await piece.save()));
  }
  return bodies;
}
