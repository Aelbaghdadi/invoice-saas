import { createHash } from "crypto";
import type { Invoice, InvoiceStatus, Prisma } from "@prisma/client";
import { putObject, deleteObject, sanitizeFilenameForStorage } from "@/lib/storage";
import { splitStorageKey } from "@/lib/splitStorageKey";
import { appendAuditLogs } from "@/lib/auditLog";
import { closeOpenIssues } from "@/lib/invoiceIssues";
import { planSplitArchive, splitPartArchiveData } from "@/lib/archiveSplit";

/**
 * Piezas comunes de dividir una factura en varias: la division a mano de la
 * revision (splitInvoice, splitPdfInvoice) y la automatica de un taco al
 * analizarlo (autoSplit.ts). Quien llama reserva la original con su propia
 * condicion; aqui se crean las hijas y se deja el rastro.
 */

/** Un trozo de una division, ya en memoria y listo para subir. */
export type SplitPiece = {
  label: string;
  filename: string;
  storageKey: string;
  fileType: string;
  body: Buffer;
};

/** Lo que heredan las hijas de la original. */
export type SplitSource = Pick<
  Invoice,
  "id" | "clientId" | "type" | "typeUnconfirmed" | "periodType" | "periodMonth" | "periodYear" | "currency"
> & Partial<Pick<Invoice, "routingCandidateIds">>;

/** Sube los trozos de una division. Si uno falla, borra los ya subidos. */
export async function uploadSplitPieces(pieces: SplitPiece[]): Promise<string | null> {
  const uploaded: string[] = [];
  for (const piece of pieces) {
    try {
      await putObject(piece.storageKey, piece.body, piece.fileType);
      uploaded.push(piece.storageKey);
    } catch (e) {
      await Promise.all(uploaded.map((key) => deleteObject(key)));
      return `Error subiendo "${piece.label}": ${e instanceof Error ? e.message : "fallo"}`;
    }
  }
  return null;
}

export function discardSplitPieces(pieces: SplitPiece[]): Promise<unknown> {
  return Promise.all(pieces.map((p) => deleteObject(p.storageKey)));
}

/**
 * Un PDF por parte, con las paginas indicadas (1-indexadas, en ese orden).
 * Lanza si el PDF no se puede leer (cifrado, dañado): quien llama decide.
 */
export async function pdfSplitPieces(
  source: Pick<Invoice, "clientId" | "periodMonth" | "periodYear">,
  originalBytes: Uint8Array,
  parts: { name: string; pages: number[] }[],
): Promise<SplitPiece[]> {
  const { PDFDocument } = await import("pdf-lib");
  const srcDoc = await PDFDocument.load(originalBytes);
  const pieces: SplitPiece[] = [];
  for (const part of parts) {
    const newDoc = await PDFDocument.create();
    // copyPages devuelve las páginas en el mismo orden que el array de índices
    const copiedPages = await newDoc.copyPages(srcDoc, part.pages.map((p) => p - 1));
    for (const p of copiedPages) newDoc.addPage(p);

    const safeName = sanitizeFilenameForStorage(`${part.name}.pdf`);
    pieces.push({
      label: part.name,
      filename: `${part.name}.pdf`,
      storageKey: splitStorageKey(source, safeName),
      fileType: "application/pdf",
      body: Buffer.from(await newDoc.save()),
    });
  }
  return pieces;
}

/** Crea las hijas (y su Document) de una original ya reservada. */
export async function createSplitChildren(
  tx: Prisma.TransactionClient,
  source: SplitSource,
  userId: string,
  pieces: SplitPiece[],
): Promise<string[]> {
  // Las hijas heredan la fila de archivo de la original (llegada, tanda,
  // medio…) con su nº de parte; bloquea la de la raíz de la familia.
  const archive = await planSplitArchive(tx, source.id);

  const ids: string[] = [];
  for (const piece of pieces) {
    const fileHash = createHash("sha256").update(piece.body).digest("hex");
    const document = await tx.document.create({
      data: {
        filename: piece.filename,
        storageKey: piece.storageKey,
        fileType: piece.fileType,
        fileHash,
        sizeBytes: piece.body.length,
        uploadedBy: userId,
        clientId: source.clientId,
      },
    });
    const child = await tx.invoice.create({
      data: {
        filename: piece.filename,
        storageKey: piece.storageKey,
        fileType: piece.fileType,
        fileHash,
        type: source.type,
        // Si el tipo de la original estaba sin confirmar ("No lo sé"), el
        // de las hijas tambien; y una trimestral sigue siendo trimestral:
        // en MONTHLY salian en otro lote.
        typeUnconfirmed: source.typeUnconfirmed,
        periodType: source.periodType,
        periodMonth: source.periodMonth,
        periodYear: source.periodYear,
        clientId: source.clientId,
        documentId: document.id,
        splitFromId: source.id,
        // La hija hereda la moneda: si su recorte no la muestra, el OCR no
        // la veria y el aviso de "no es euro" desapareceria en silencio.
        currency: source.currency,
        // Un taco subido en modo clasificar: cada hija se rutea por su CIF,
        // que en un taco mezclado puede ser de otro cliente.
        routingCandidateIds: source.routingCandidateIds ?? [],
      },
    });
    await tx.invoiceArchive.update({ where: { invoiceId: child.id }, data: splitPartArchiveData(archive, ids.length) });
    ids.push(child.id);
  }
  return ids;
}

/** Historial y auditoria de la original que pasa a SPLIT_SOURCE. */
export async function recordSplitSource(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  fromStatus: InvoiceStatus,
  userId: string,
  extraAudit: { field: string; oldValue: string | null; newValue: string | null }[] = [],
): Promise<void> {
  // F-057: la original sale del flujo; las hijas generan las suyas al
  // pasar por el OCR.
  await closeOpenIssues(tx, invoiceId, userId);
  await tx.invoiceStatusHistory.create({
    data: { invoiceId, fromStatus, toStatus: "SPLIT_SOURCE", changedBy: userId },
  });
  await appendAuditLogs([
    { invoiceId, userId, field: "status", oldValue: fromStatus, newValue: "SPLIT_SOURCE" },
    ...extraAudit.map((e) => ({ invoiceId, userId, ...e })),
  ], tx);
}
