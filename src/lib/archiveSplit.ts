/**
 * La fila de archivo de las partes de una división (R11, R15 y anexo C14).
 * Las partes son el mismo papel que la factura que se divide: heredan su
 * llegada, su tanda y posición, dónde está el papel, «lo guarda el cliente» y
 * el medio con su origen, con motivo «split». Cada parte lleva un splitPart
 * propio en toda la familia, que es la de la raíz: una parte que se vuelve a
 * dividir sigue numerando detrás de sus hermanas, como el relleno de la 12.
 */
import { Prisma } from "@prisma/client";

/** Tope de niveles al recorrer una familia: en la práctica son uno o dos. */
const MAX_SPLIT_DEPTH = 100;

export type SplitArchivePlan = {
  rootId: string;
  /** splitPart de la primera parte; las siguientes, +1, +2… */
  firstPart: number;
  inherited: Prisma.InvoiceArchiveUncheckedUpdateInput;
};

/**
 * Se llama dentro de la transacción de la división, después de reservar la
 * factura. Bloquea la fila de archivo de la raíz antes de leer el mayor
 * splitPart de la familia: dos hermanas que se dividen a la vez se esperan
 * aquí y la segunda numera detrás de la primera (sin el bloqueo, las dos
 * leían el mismo máximo y repetían números).
 */
export async function planSplitArchive(tx: Prisma.TransactionClient, invoiceId: string): Promise<SplitArchivePlan> {
  const [root] = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up AS (
      SELECT "id", "splitFromId", 0 AS depth FROM "Invoice" WHERE "id" = ${invoiceId}
      UNION ALL
      SELECT i."id", i."splitFromId", up.depth + 1
      FROM "Invoice" i JOIN up ON i."id" = up."splitFromId"
      WHERE up.depth < ${MAX_SPLIT_DEPTH}
    )
    SELECT "id" FROM up WHERE "splitFromId" IS NULL`;
  const rootId = root?.id ?? invoiceId;
  await tx.$queryRaw`SELECT "invoiceId" FROM "InvoiceArchive" WHERE "invoiceId" = ${rootId} FOR UPDATE`;

  const source = await tx.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });
  // Lo que comparte su tanda y posición es del mismo papel (el unique de
  // tanda, posición y parte): también cuenta para el máximo.
  const samePaper = source.uploadBatchId != null && source.uploadPosition != null
    ? Prisma.sql` OR (a."uploadBatchId" = ${source.uploadBatchId} AND a."uploadPosition" = ${source.uploadPosition})`
    : Prisma.empty;
  const [{ maxPart }] = await tx.$queryRaw<{ maxPart: number }[]>`
    WITH RECURSIVE fam AS (
      SELECT "id", 0 AS depth FROM "Invoice" WHERE "splitFromId" = ${rootId}
      UNION ALL
      SELECT c."id", fam.depth + 1
      FROM "Invoice" c JOIN fam ON c."splitFromId" = fam."id"
      WHERE fam.depth < ${MAX_SPLIT_DEPTH}
    )
    SELECT COALESCE(MAX(a."splitPart"), 0)::int AS "maxPart"
    FROM "InvoiceArchive" a
    WHERE a."invoiceId" IN (SELECT "id" FROM fam)${samePaper}`;

  return {
    rootId,
    firstPart: maxPart + 1,
    inherited: {
      receivedAt: source.receivedAt,
      uploadBatchId: source.uploadBatchId,
      uploadPosition: source.uploadPosition,
      paperBatchId: source.paperBatchId,
      paperHeldByClient: source.paperHeldByClient,
      originalMedium: source.originalMedium,
      originalMediumSource: source.originalMediumSource,
      originalMediumReason: "split",
      pdfProducer: source.pdfProducer,
    },
  };
}

/** Lo que se escribe en la fila de archivo de la parte `index` (0, 1…). */
export function splitPartArchiveData(plan: SplitArchivePlan, index: number): Prisma.InvoiceArchiveUncheckedUpdateInput {
  return { ...plan.inherited, splitPart: plan.firstPart + index };
}
