/**
 * Nº de registro del archivo al exportar a A3 (R6-R8). Se pone dentro de la
 * transacción de commitExportBatch: si la exportación se deshace, no se gasta
 * ningún número, y reexportar no lo cambia (las que ya lo tienen se saltan).
 *
 * Orden de bloqueo, después de las facturas que reserva el export: sus filas de
 * archivo (en orden de factura, como las ediciones del archivo), los contadores
 * de las series (en orden de clave) y, al final, las cadenas de auditoría.
 */
import type { Prisma } from "@prisma/client";
import { ExportConflictError } from "@/lib/exportConflict";
import { formatRegisterNumber, planRegisterNumbers } from "@/lib/registerNumbers";

export type RegisterAuditEntry = {
  invoiceId: string;
  userId: string;
  field: "registerNumber";
  oldValue: null;
  newValue: string;
};

/**
 * Numera las facturas de un lote que aún no tienen nº de registro y devuelve
 * sus entradas de auditoría (de «—» a «R-2026/0153»), para que el export las
 * escriba con las suyas. registeredAt es la fecha del lote.
 */
export async function assignRegisterNumbers(
  tx: Prisma.TransactionClient,
  invoiceIds: string[],
  registeredAt: Date,
  userId: string,
): Promise<RegisterAuditEntry[]> {
  if (invoiceIds.length === 0) return [];

  // La fila la crea un trigger al dar de alta la factura. Si faltara (los
  // triggers quitados en una emergencia), se crea como él en vez de dar un
  // conflicto que no lo es en cada intento.
  await tx.$executeRaw`
    INSERT INTO "InvoiceArchive" ("invoiceId", "receivedAt", "createdAt", "updatedAt")
    SELECT i."id", i."createdAt", now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC'
    FROM "Invoice" i
    WHERE i."id" = ANY(${invoiceIds}::text[])
    ON CONFLICT ("invoiceId") DO NOTHING`;
  await tx.$executeRaw`
    SELECT 1 FROM "InvoiceArchive"
    WHERE "invoiceId" = ANY(${invoiceIds}::text[])
    ORDER BY "invoiceId"
    FOR UPDATE`;

  const rows = await tx.invoiceArchive.findMany({
    where: { invoiceId: { in: invoiceIds } },
    select: {
      invoiceId: true,
      receivedAt: true,
      uploadPosition: true,
      splitPart: true,
      registerNumber: true,
      invoice: {
        select: {
          clientId: true,
          type: true,
          periodType: true,
          periodMonth: true,
          periodYear: true,
          accountingPeriodMonth: true,
          accountingPeriodYear: true,
          invoiceDate: true,
          invoiceNumber: true,
          createdAt: true,
        },
      },
    },
  });
  // Sin contador: cada bloque sale numerado 1..n y se desplaza con el último
  // número que devuelve la reserva.
  const blocks = planRegisterNumbers(
    rows.map(({ invoice, invoiceId, ...archive }) => ({ ...invoice, ...archive, id: invoiceId })),
  );
  if (blocks.length === 0) return [];

  const ids: string[] = [];
  const seriesIds: string[] = [];
  const numbers: number[] = [];
  const audit: RegisterAuditEntry[] = [];
  for (const block of blocks) {
    const count = block.entries.length;
    // Reserva el bloque y bloquea la fila de la serie hasta el COMMIT: otro
    // export de la misma serie espera aquí y sigue desde este último número.
    const [series] = await tx.$queryRaw<{ id: string; lastNumber: number }[]>`
      INSERT INTO "InvoiceRegisterSeries" ("id", "clientId", "type", "year", "lastNumber", "updatedAt")
      VALUES (gen_random_uuid()::text, ${block.clientId}, ${block.type}::"InvoiceType", ${block.year}, ${count}, now() AT TIME ZONE 'UTC')
      ON CONFLICT ("clientId", "type", "year") DO UPDATE
      SET "lastNumber" = "InvoiceRegisterSeries"."lastNumber" + EXCLUDED."lastNumber",
          "updatedAt" = now() AT TIME ZONE 'UTC'
      RETURNING "id", "lastNumber"`;
    const offset = series.lastNumber - count;
    for (const entry of block.entries) {
      const number = offset + entry.number;
      ids.push(entry.invoiceId);
      seriesIds.push(series.id);
      numbers.push(number);
      audit.push({
        invoiceId: entry.invoiceId,
        userId,
        field: "registerNumber",
        oldValue: null,
        newValue: formatRegisterNumber(block, number),
      });
    }
  }

  const written = await tx.$executeRaw`
    UPDATE "InvoiceArchive" a
    SET "registerSeriesId" = u."seriesId",
        "registerNumber" = u."number",
        "registeredAt" = ${registeredAt}::timestamp(3),
        "updatedAt" = now() AT TIME ZONE 'UTC'
    FROM unnest(${ids}::text[], ${seriesIds}::text[], ${numbers}::int[]) AS u("invoiceId", "seriesId", "number")
    WHERE a."invoiceId" = u."invoiceId" AND a."registerNumber" IS NULL`;
  if (written !== ids.length) {
    throw new ExportConflictError(ids, `numeradas ${written} de ${ids.length}`);
  }
  return audit;
}
