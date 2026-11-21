import type { Invoice, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { classifyPdfPagesWithGemini } from "@/lib/ocrLlm";
import { ocrFenceWhere } from "@/lib/invoiceStatuses";
import { segmentPages, segmentationSummary, worthSplitting } from "@/lib/pdfSegmentation";
import {
  createSplitChildren,
  discardSplitPieces,
  pdfSplitPieces,
  recordSplitSource,
  uploadSplitPieces,
} from "@/lib/invoiceSplit";

/**
 * Por encima de esto el PDF no cabe en una peticion a Gemini (20 MB, y el
 * base64 ocupa un tercio mas): ni se intenta, va entero al OCR como siempre.
 */
export const AUTO_SPLIT_MAX_BYTES = 14 * 1024 * 1024;

/**
 * Separacion automatica de un taco (varias facturas en un PDF, con albaranes
 * o paginas en blanco por medio). Se llama al analizar, con la factura ya en
 * ANALYZING: si el PDF trae varias facturas o paginas que sobran, la original
 * pasa a SPLIT_SOURCE con una hija por factura (sin las paginas descartadas)
 * y devuelve sus ids para que pasen por el OCR. Si no, null y el analisis
 * sigue como siempre. `afterSplit` corre en la misma transaccion, con las
 * hijas ya creadas (el medio del original, que heredan las partes).
 *
 * Nunca hace fallar el analisis: si Gemini no responde o el PDF no se puede
 * partir, se sigue con el PDF entero (el gestor siempre puede «Dividir»).
 */
export async function autoSplitPdf(
  invoice: Pick<
    Invoice,
    | "id" | "filename" | "clientId" | "type" | "typeUnconfirmed" | "periodType" | "periodMonth" | "periodYear"
    | "currency" | "routingCandidateIds" | "splitFromId"
  >,
  ocrToken: number,
  userId: string,
  pdfBytes: Buffer,
  afterSplit: (tx: Prisma.TransactionClient) => Promise<void> = async () => {},
): Promise<string[] | null> {
  // Una hija ya es el resultado de una division: no se vuelve a partir.
  if (invoice.splitFromId || pdfBytes.length > AUTO_SPLIT_MAX_BYTES) return null;

  let numPages: number;
  try {
    const { PDFDocument } = await import("pdf-lib");
    numPages = (await PDFDocument.load(pdfBytes)).getPageCount();
  } catch {
    return null; // cifrado o dañado: que lo diga el OCR
  }
  if (numPages < 2) return null;

  let segmentation;
  try {
    const readings = await classifyPdfPagesWithGemini(pdfBytes.toString("base64"));
    segmentation = readings ? segmentPages(readings, numPages) : null;
  } catch (e) {
    console.warn(`[autoSplit] ${invoice.id}: no se pudieron clasificar las páginas; se analiza entero:`, e);
    return null;
  }
  if (!worthSplitting(segmentation)) return null;

  const base = invoice.filename.replace(/\.pdf$/i, "");
  const total = segmentation.invoices.length;
  let pieces;
  try {
    pieces = await pdfSplitPieces(invoice, pdfBytes, segmentation.invoices.map((pages, i) => ({
      name: total === 1 ? `${base} (sin relleno)` : `${base} (factura ${i + 1} de ${total})`,
      pages,
    })));
  } catch (e) {
    console.warn(`[autoSplit] ${invoice.id}: no se pudieron generar las partes; se analiza entero:`, e);
    return null;
  }
  const uploadErr = await uploadSplitPieces(pieces);
  if (uploadErr) {
    console.warn(`[autoSplit] ${invoice.id}: ${uploadErr}; se analiza entero`);
    return null;
  }

  try {
    const childIds = await prisma.$transaction(async (tx) => {
      // Con la valla del OCR: si otra ejecucion ha cogido la factura (el cron
      // la relanzo), esta no la parte.
      const reserved = await tx.invoice.updateMany({
        where: ocrFenceWhere(invoice.id, ocrToken),
        data: { status: "SPLIT_SOURCE" },
      });
      if (reserved.count === 0) return null;
      const ids = await createSplitChildren(tx, invoice, userId, pieces);
      await recordSplitSource(tx, invoice.id, "ANALYZING", userId, [
        { field: "auto:division", oldValue: `${numPages} páginas`, newValue: segmentationSummary(segmentation) },
      ]);
      await afterSplit(tx);
      return ids;
    }, { timeout: 30_000, maxWait: 5_000 });
    if (!childIds) await discardSplitPieces(pieces);
    // Sin la valla no es nuestra: ni partir ni analizar (lo hace la otra).
    return childIds ?? [];
  } catch (e) {
    await discardSplitPieces(pieces);
    console.warn(`[autoSplit] ${invoice.id}: no se pudo guardar la división; se analiza entero:`, e);
    return null;
  }
}
