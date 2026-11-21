/**
 * Detección de electrónico o papel de los PDF de antes del archivo (anexo C3).
 * El relleno de la migración 12 los dejó «Por confirmar» con motivo
 * backfill_pending: aquí se miran como al analizar (capa de texto y productor
 * del PDF, R10), sin tocar nada más de la factura. Idempotente: lo lanza
 * /api/cron/archivo-detectar hasta que no queda ninguno.
 *
 * Solo se eligen facturas que no son parte de una división: las partes heredan
 * de su raíz (su motivo es split) y les llega la propuesta con ella (C18). El
 * fichero que se mira es siempre el de la raíz, el que llegó a la asesoría.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getObjectBytes, isStorageNotFound } from "@/lib/storage";
import { extractPdfTextAndItems, pdfReadingForMedium } from "@/lib/ocrLlm";
import { archiveEditConflict, writeAutoMedium, type AutoMediumWrite } from "@/lib/archiveEdits";
import { postgresErrorCode } from "@/lib/exportConflict";
import type { PdfReading } from "@/lib/originalMedium";

/** Facturas por llamada: por defecto y como mucho. */
export const ARCHIVE_MEDIUM_BACKFILL_LIMIT = { default: 50, max: 200 };

/**
 * Espera máxima de un bloqueo (lock_timeout) al escribir cada factura: si otra
 * escritura retiene su familia (un export grande, una división), la factura
 * va a `errores` y la siguiente llamada la retoma. Un objeto para que los
 * tests la puedan acortar.
 */
export const ARCHIVE_MEDIUM_BACKFILL_WAITS = { lockTimeoutMs: 5_000 };

/** La transacción de cada factura: holgura para dos esperas (la raíz y el
 *  resto de la familia) por debajo de su tope; con el de por defecto (5 s),
 *  una espera larga acababa en P2028. */
const WRITE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 20_000 };

/** Tope de cada descarga, como el del análisis. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type ArchiveMediumBackfillResult = {
  /** Facturas repasadas en esta llamada. */
  revisadas: number;
  /** Las que han quedado electrónicas (PDF con texto, de un programa). */
  electronicas: number;
  /** Las que siguen «Por confirmar»: escaneos. */
  porConfirmar: number;
  /** Las que no se han podido leer (el PDF no está o está dañado). */
  ilegibles: number;
  /** Las que se han quedado como estaban por un fallo (el almacenamiento no
   *  responde, otra escritura a la vez, o uno que se repite y queda en el
   *  log): la siguiente llamada las vuelve a mirar. */
  errores: number;
  /** Las pendientes que quedan después de esta llamada. */
  quedan: number;
};

const pendingWhere: Prisma.InvoiceArchiveWhereInput = {
  originalMediumSource: "AUTO",
  originalMediumReason: "backfill_pending",
  invoice: { splitFromId: null },
};

/** Cuántas quedan por detectar, sin descargar ni escribir nada. */
export function countPendingMediumBackfill(): Promise<number> {
  return prisma.invoiceArchive.count({ where: pendingWhere });
}

/** Lo que se lee del PDF; null si el almacenamiento falla (no por un PDF que no está). */
async function readStoredPdf(storageKey: string): Promise<PdfReading | null> {
  try {
    const bytes = await getObjectBytes(storageKey, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    return pdfReadingForMedium(await extractPdfTextAndItems(bytes.toString("base64")));
  } catch (err) {
    if (isStorageNotFound(err)) return { text: "", failed: true };
    console.warn(`[archivo-detectar] ${storageKey}: no se ha podido descargar:`, err);
    return null;
  }
}

type PendingRow = { invoiceId: string; invoice: { fileType: string } };

/** Escribe lo leído si la fila sigue pendiente; null si ya no lo estaba. */
function writePending(row: PendingRow, pdf: PdfReading): Promise<AutoMediumWrite | null> {
  return prisma.$transaction(async (tx) => {
    // SET LOCAL lock_timeout; set_config admite el valor como parámetro.
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${ARCHIVE_MEDIUM_BACKFILL_WAITS.lockTimeoutMs}ms`}, true)`;
    return writeAutoMedium(tx, { invoiceId: row.invoiceId, fileType: row.invoice.fileType, pdf, pendingOnly: true });
  }, WRITE_TRANSACTION_OPTIONS);
}

/** Error de datos de Postgres (clase 22, como un NUL en el productor: 22021). */
function isDataError(err: unknown): boolean {
  return postgresErrorCode(err)?.startsWith("22") ?? false;
}

/**
 * Lo leído de una factura. Si Postgres no admite lo leído, se repetiría en
 * cada llamada y la fila quedaría pendiente para siempre: queda «No se pudo
 * leer el PDF», sin productor.
 */
async function detectOne(row: PendingRow, pdf: PdfReading): Promise<AutoMediumWrite | null> {
  try {
    return await writePending(row, pdf);
  } catch (err) {
    if (!isDataError(err)) throw err;
    console.error(`[archivo-detectar] ${row.invoiceId}: lo leído del PDF no se puede guardar; queda «No se pudo leer el PDF»:`, err);
    return writePending(row, { text: "", failed: true });
  }
}

/**
 * Repasa hasta `limit` facturas pendientes, de cualquier asesoría (cada una
 * solo escribe en su propia fila y en las de sus partes). Escribe solo si la
 * fila sigue AUTO y pendiente: si mientras tanto la ha analizado la app o la
 * ha cambiado una persona, no la pisa. Sin auditoría: es la primera propuesta.
 * Una factura que falla no para a las demás: va a `errores` (y al log si no
 * es un cruce con otra escritura).
 */
export async function runArchiveMediumBackfill(
  options: { limit?: number } = {},
): Promise<ArchiveMediumBackfillResult> {
  const limit = Math.min(options.limit ?? ARCHIVE_MEDIUM_BACKFILL_LIMIT.default, ARCHIVE_MEDIUM_BACKFILL_LIMIT.max);
  const pending = await prisma.invoiceArchive.findMany({
    where: pendingWhere,
    orderBy: { invoiceId: "asc" },
    take: limit,
    select: { invoiceId: true, invoice: { select: { storageKey: true, fileType: true } } },
  });

  const result: ArchiveMediumBackfillResult = {
    revisadas: pending.length, electronicas: 0, porConfirmar: 0, ilegibles: 0, errores: 0, quedan: 0,
  };
  for (const row of pending) {
    const pdf = await readStoredPdf(row.invoice.storageKey);
    if (!pdf) {
      result.errores++;
      continue;
    }
    try {
      const written = await detectOne(row, pdf);
      if (!written) continue;
      if (written.proposal.medium === "ELECTRONIC") result.electronicas++;
      else if (written.proposal.reason === "pdf_unreadable") result.ilegibles++;
      else result.porConfirmar++;
    } catch (err) {
      if (!archiveEditConflict(err)) console.error(`[archivo-detectar] ${row.invoiceId}: no se ha podido guardar:`, err);
      result.errores++;
    }
  }
  result.quedan = await countPendingMediumBackfill();
  return result;
}
