/**
 * El taco entero en un PDF (B-R9). Mientras no se divide, su PDF es un
 * Document colgado de la tanda, sin Invoice: no entra en la cola de revisión,
 * ni en los contadores, ni en el OCR, ni en retry-stuck (§2.1). Se divide una
 * vez, cuando el gestor marca dónde empieza cada factura.
 *
 * Cada trozo es una factura normal del taco, con la página del PDF donde
 * empieza como posición (B-R7), y no una «parte» de una división: en el
 * archivo una familia es un solo papel, y con 52 facturas colgando de una raíz
 * cambiar el medio o adjuntar un Word a una lo haría en todas (§2.2). Se
 * reutiliza el corte y la subida de los trozos de la división de la revisión
 * (pdfPieces.ts).
 */
import { createHash } from "node:crypto";
import type { PeriodType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadBatchVisibleWhere, type TacoViewer } from "@/lib/archiveAccess";
import { archiveIntakeFields } from "@/lib/archiveIntake";
import { tacoLabel, pageRangeLabel } from "@/lib/paperLocation";
import { loadPdf, slicePdf, uploadSplitPieces, type SplitPiece } from "@/lib/pdfPieces";
import { periodLabel } from "@/lib/period";
import { deleteObject, getObjectBytes, isStorageNotFound, sanitizeFilenameForStorage } from "@/lib/storage";
import { planTacoRanges } from "@/lib/tacoSplitPlan";
import { uploadStorageKey } from "@/lib/uploadStorageKey";

export const TACO_SPLIT_BUSY_ERROR = "Otra persona está dividiendo este taco ahora mismo. Espera un momento y recarga la página.";
export const TACO_SPLIT_NOT_FOUND_ERROR = "No se ha encontrado el taco.";
export const TACO_ALREADY_SPLIT_ERROR = "Este taco ya está dividido.";
export const TACO_SPLIT_VOIDED_ERROR = "Este taco está anulado.";
export const TACO_SPLIT_LOST_ERROR = "Otra persona ya ha marcado las facturas de este taco. Recarga la página.";
export const TACO_SPLIT_FAILED_ERROR = "No se ha podido dividir el taco. No se ha cambiado nada: vuelve a intentarlo.";
export const TACO_PDF_UNREADABLE_ERROR =
  "No se ha podido leer el PDF del taco. Vuelve a intentarlo; si sigue igual, anula el taco y súbelo otra vez.";

/** Trozos que se suben a la vez: 300 de uno en uno tardarían demasiado. */
export const TACO_SPLIT_UPLOAD_CONCURRENCY = 4;
/** Con 300 trozos son unas 900 sentencias cortas: caben de sobra. */
const SPLIT_TRANSACTION = { timeout: 60_000, maxWait: 5_000 } as const;

export function tacoPeriodClosedError(lot: { periodType: PeriodType; periodMonth: number; periodYear: number }): string {
  return `El periodo ${periodLabel(lot.periodType, lot.periodMonth, lot.periodYear)} de este cliente está cerrado: pide que lo reabran para dividir el taco.`;
}

/** El error de Lotes y de Cierres con un taco entero sin dividir en el periodo (5.9). */
export function pendingTacoSplitCloseError(tacoNumber: number): string {
  return `No se puede cerrar: el ${tacoLabel(tacoNumber)} de este periodo está sin dividir. Marca dónde empieza cada factura primero (o anúlalo si se subió por error).`;
}

// Tacos que se están dividiendo en este proceso. Cortar y subir 300 trozos
// tarda: el segundo que llega se avisa enseguida, sin gastar ese trabajo. Entre
// procesos lo decide la reserva (pdfSplitAt). En globalThis, como la cola del
// OCR: en desarrollo el recargado de módulos creaba otro.
const globalForSplits = globalThis as unknown as { __facturocrTacoSplits?: Set<string> };
const splitting: Set<string> = (globalForSplits.__facturocrTacoSplits ??= new Set());

type Lot = { clientId: string; periodType: PeriodType; periodMonth: number; periodYear: number };

/** Texto del periodo cerrado del lote del taco, o null si está abierto. */
async function closedPeriodText(db: Prisma.TransactionClient, lot: Lot): Promise<string | null> {
  const closure = await db.periodClosure.findUnique({
    where: { clientId_month_year: { clientId: lot.clientId, month: lot.periodMonth, year: lot.periodYear } },
    select: { reopenedAt: true },
  });
  return closure && !closure.reopenedAt ? tacoPeriodClosedError(lot) : null;
}

/** La reserva no ha salido: otra persona lo ha dividido (o anulado) entretanto. */
class SplitReservationLost extends Error {}
/** Han cerrado el periodo mientras se cortaban y subían los trozos. */
class PeriodClosedMeanwhile extends Error {}

/**
 * Divide un taco entero: una factura por cada página marcada, hasta la
 * anterior a la siguiente marca (lo de antes de la primera es «sin factura»).
 * El acceso al taco lo comprueba quien llama (la acción, con
 * canAccessUploadBatch). Nunca lanza.
 *
 * Orden: comprobaciones → descargar y cortar el PDF → subir los trozos → en
 * una transacción, reservar el taco (pdfSplitAt), volver a mirar el periodo y
 * crear Document, Invoice y fila de archivo de cada trozo. Si algo falla, se
 * deshace todo y se borran los trozos subidos. El OCR lo lanza la acción.
 */
export async function splitWholeTaco(input: {
  firmId: string;
  userId: string;
  batchId: string;
  startPages: number[];
}): Promise<{ ok: true; invoiceIds: string[] } | { error: string }> {
  if (splitting.has(input.batchId)) return { error: TACO_SPLIT_BUSY_ERROR };
  splitting.add(input.batchId);
  try {
    return await splitOnce(input);
  } catch (err) {
    console.error(`[taco entero] ${input.batchId}: no se ha podido dividir:`, err);
    return { error: TACO_SPLIT_FAILED_ERROR };
  } finally {
    splitting.delete(input.batchId);
  }
}

async function splitOnce(input: {
  firmId: string;
  userId: string;
  batchId: string;
  startPages: number[];
}): Promise<{ ok: true; invoiceIds: string[] } | { error: string }> {
  const { firmId, userId } = input;
  const batch = await prisma.uploadBatch.findFirst({
    where: { id: input.batchId, advisoryFirmId: firmId },
    select: {
      id: true, tacoNumber: true, clientId: true, wholePdf: true, pdfSplitAt: true, voidedAt: true, pdfPageCount: true,
      periodType: true, periodMonth: true, periodYear: true, invoiceType: true, createdAt: true,
      pdfDocument: { select: { storageKey: true } },
    },
  });
  if (
    !batch || !batch.wholePdf || !batch.clientId || !batch.pdfDocument || batch.tacoNumber == null
    || batch.pdfPageCount == null || !batch.periodType || batch.periodMonth == null || !batch.invoiceType
  ) {
    return { error: TACO_SPLIT_NOT_FOUND_ERROR };
  }
  if (batch.voidedAt) return { error: TACO_SPLIT_VOIDED_ERROR };
  if (batch.pdfSplitAt) return { error: TACO_ALREADY_SPLIT_ERROR };
  const lot: Lot = { clientId: batch.clientId, periodType: batch.periodType, periodMonth: batch.periodMonth, periodYear: batch.periodYear };

  // Antes de subir nada: si no, quedarían trozos huérfanos en el almacenamiento.
  const closed = await closedPeriodText(prisma, lot);
  if (closed) return { error: closed };
  const plan = planTacoRanges(input.startPages, batch.pdfPageCount);
  if (!plan.ok) return { error: plan.error };

  let bodies: Buffer[];
  try {
    const source = await getObjectBytes(batch.pdfDocument.storageKey);
    const doc = await loadPdf(source);
    // El que se comprobó al subirlo: si no cuadra, las marcas no son de este PDF.
    if (doc.getPageCount() !== batch.pdfPageCount) {
      throw new Error(`el PDF tiene ${doc.getPageCount()} páginas y el taco ${batch.pdfPageCount}`);
    }
    bodies = await slicePdf(doc, plan.ranges);
  } catch (err) {
    if (isStorageNotFound(err)) {
      console.error(`[taco entero] falta el PDF del ${tacoLabel(batch.tacoNumber)} (${batch.id}) en el almacenamiento: ${batch.pdfDocument.storageKey}`);
    } else {
      console.error(`[taco entero] ${batch.id}: no se ha podido leer o cortar el PDF:`, err);
    }
    return { error: TACO_PDF_UNREADABLE_ERROR };
  }

  const name = tacoLabel(batch.tacoNumber);
  const pieces: SplitPiece[] = plan.ranges.map((range, i) => {
    const filename = `${name} - pág. ${pageRangeLabel(range.start, range.end)}.pdf`;
    return {
      label: filename,
      filename,
      storageKey: uploadStorageKey(lot, sanitizeFilenameForStorage(filename)),
      fileType: "application/pdf",
      body: bodies[i],
    };
  });
  const uploadError = await uploadSplitPieces(pieces, { concurrency: TACO_SPLIT_UPLOAD_CONCURRENCY });
  if (uploadError) {
    console.error(`[taco entero] ${batch.id}: ${uploadError}`);
    return { error: TACO_SPLIT_FAILED_ERROR };
  }

  // Tipo y lote del taco; con «Detectar automáticamente», el provisional y sin confirmar, como al subir.
  const invoiceType = batch.invoiceType === "SALE" ? "SALE" : "PURCHASE";
  const typeUnconfirmed = batch.invoiceType === "UNKNOWN";
  const intake = archiveIntakeFields({ fileType: "application/pdf", uploadedByClient: false, inTaco: true });
  try {
    const invoiceIds = await prisma.$transaction(async (tx) => {
      // La reserva primero: si otra persona lo ha dividido o anulado mientras
      // se cortaban los trozos, no se crea nada.
      const reserved = await tx.uploadBatch.updateMany({
        where: { id: batch.id, advisoryFirmId: firmId, wholePdf: true, pdfSplitAt: null, voidedAt: null },
        data: { pdfSplitAt: new Date(), pdfSplitById: userId },
      });
      if (reserved.count === 0) throw new SplitReservationLost();
      const closedNow = await closedPeriodText(tx, lot);
      if (closedNow) throw new PeriodClosedMeanwhile(closedNow);

      const ids: string[] = [];
      for (const [i, piece] of pieces.entries()) {
        const fileHash = createHash("sha256").update(piece.body).digest("hex");
        const document = await tx.document.create({
          data: {
            filename: piece.filename,
            storageKey: piece.storageKey,
            fileType: piece.fileType,
            fileHash,
            sizeBytes: piece.body.length,
            uploadedBy: userId,
            clientId: lot.clientId,
          },
          select: { id: true },
        });
        const invoice = await tx.invoice.create({
          data: {
            filename: piece.filename,
            storageKey: piece.storageKey,
            fileType: piece.fileType,
            fileHash,
            type: invoiceType,
            typeUnconfirmed,
            periodType: lot.periodType,
            periodMonth: lot.periodMonth,
            periodYear: lot.periodYear,
            clientId: lot.clientId,
            documentId: document.id,
          },
          select: { id: true },
        });
        // La fila la ha creado el trigger. Papel del taco desde el alta (B-R8),
        // llegada = la del taco y su página = la del PDF donde empieza.
        await tx.invoiceArchive.update({
          where: { invoiceId: invoice.id },
          data: { ...intake, uploadBatchId: batch.id, uploadPosition: plan.ranges[i].start, receivedAt: batch.createdAt },
        });
        ids.push(invoice.id);
      }
      return ids;
    }, SPLIT_TRANSACTION);
    return { ok: true, invoiceIds };
  } catch (err) {
    await Promise.all(pieces.map((piece) => deleteObject(piece.storageKey)));
    if (err instanceof PeriodClosedMeanwhile) return { error: err.message };
    if (err instanceof SplitReservationLost) return { error: await lostReservationError(batch.id) };
    console.error(`[taco entero] ${batch.id}: no se han podido crear las facturas:`, err);
    return { error: TACO_SPLIT_FAILED_ERROR };
  }
}

/** Por qué no ha salido la reserva, mirado otra vez después. */
async function lostReservationError(batchId: string): Promise<string> {
  const now = await prisma.uploadBatch
    .findUnique({ where: { id: batchId }, select: { voidedAt: true, pdfSplitAt: true } })
    .catch(() => null);
  if (now?.voidedAt) return TACO_SPLIT_VOIDED_ERROR;
  if (now?.pdfSplitAt) return TACO_SPLIT_LOST_ERROR;
  return TACO_SPLIT_FAILED_ERROR;
}

export type TacoToSplit = {
  id: string;
  tacoNumber: number;
  clientName: string;
  periodType: PeriodType;
  periodMonth: number;
  periodYear: number;
  invoiceType: string;
  pageCount: number;
  /** Ya dividido o anulado: la pantalla de las marcas lleva al detalle. */
  done: boolean;
};

/**
 * Lo que necesita la pantalla de las marcas (5.8), o null si no es un taco
 * entero de la asesoría. El acceso del que mira (B-R20) lo comprueba la página.
 */
export async function loadTacoToSplit(firmId: string, batchId: string): Promise<TacoToSplit | null> {
  const batch = await prisma.uploadBatch.findFirst({
    where: { id: batchId, advisoryFirmId: firmId, wholePdf: true },
    select: {
      id: true, tacoNumber: true, pdfPageCount: true, pdfSplitAt: true, voidedAt: true,
      periodType: true, periodMonth: true, periodYear: true, invoiceType: true,
      client: { select: { name: true } },
    },
  });
  if (!batch || batch.tacoNumber == null || batch.pdfPageCount == null || !batch.client
    || !batch.periodType || batch.periodMonth == null || !batch.invoiceType) {
    return null;
  }
  return {
    id: batch.id,
    tacoNumber: batch.tacoNumber,
    clientName: batch.client.name,
    periodType: batch.periodType,
    periodMonth: batch.periodMonth,
    periodYear: batch.periodYear,
    invoiceType: batch.invoiceType,
    pageCount: batch.pdfPageCount,
    done: batch.pdfSplitAt != null || batch.voidedAt != null,
  };
}

export type PendingTacoSplit = { id: string; tacoNumber: number; clientName: string; pageCount: number; createdAt: Date };

/** Tacos enteros sin dividir ni anular que ve (B-R20), del más antiguo al más nuevo. */
export async function pendingTacoSplits(viewer: TacoViewer): Promise<PendingTacoSplit[]> {
  const rows = await prisma.uploadBatch.findMany({
    where: { AND: [uploadBatchVisibleWhere(viewer), { wholePdf: true, pdfSplitAt: null, voidedAt: null }] },
    select: { id: true, tacoNumber: true, pdfPageCount: true, createdAt: true, client: { select: { name: true } } },
    orderBy: { tacoNumber: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    tacoNumber: row.tacoNumber ?? 0,
    clientName: row.client?.name ?? "",
    pageCount: row.pdfPageCount ?? 0,
    createdAt: row.createdAt,
  }));
}

/**
 * Nº del primer taco entero sin dividir ni anular de ese cliente cuyo lote es
 * ese mes y año (el mes guardado: en trimestral, el primero), o null. Con uno,
 * el periodo no se cierra ni desde Lotes ni desde Cierres: sus facturas aún no
 * existen.
 */
export async function pendingTacoSplitInPeriod(clientId: string, month: number, year: number): Promise<number | null> {
  const taco = await prisma.uploadBatch.findFirst({
    where: { clientId, periodMonth: month, periodYear: year, wholePdf: true, pdfSplitAt: null, voidedAt: null },
    select: { tacoNumber: true },
    orderBy: { tacoNumber: "asc" },
  });
  return taco?.tacoNumber ?? null;
}
