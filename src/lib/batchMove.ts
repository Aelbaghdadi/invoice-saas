/**
 * «Mover a otro lote…» desde Lotes: lleva las facturas de un lote a otro del
 * mismo cliente y tipo. Para juntar lo que se separó al subir, p. ej. las de
 * octubre que se subieron con «noviembre» y abrieron otro lote. Sin imports
 * de Next: la acción de Lotes es una capa fina encima.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs, AUDIT_TRANSACTION_OPTIONS } from "@/lib/auditLog";
import { batchLabel, planBatchMove, samePeriod, type BatchPeriod, type BatchRef } from "@/lib/batchTarget";
import { periodLabel } from "@/lib/period";

export type MoveBatchResult = { error: string } | { movidas: number; quedan: number };

/** Campo de la auditoría: una entrada por factura movida, con los dos lotes. */
export const BATCH_AUDIT_FIELD = "lote";

// Para deshacer la transacción si otra persona se adelantó: sin ninguna
// factura movida, tampoco se mueve la original de una división.
class StaleBatchError extends Error {}

/**
 * Mueve al periodo `to` las facturas del lote `from` (el tipo no cambia),
 * según planBatchMove: las que ya salieron en un Excel se quedan y la original
 * de una división va con sus hijas. El periodo contable no se toca.
 *
 * Con el periodo de origen o el de destino cerrado no se mueve nada, como al
 * subir o al rechazar el lote: el cierre fija lo que hay en el periodo.
 *
 * El acceso del usuario al cliente lo comprueba quien llama; aquí, además,
 * que el cliente sea de la asesoría y no el buzón «Sin clasificar».
 */
export async function moveBatchInvoices(input: {
  firmId: string;
  clientId: string;
  from: BatchRef;
  to: BatchPeriod;
  userId: string;
}): Promise<MoveBatchResult> {
  const { firmId, clientId, from, userId } = input;
  const to: BatchRef = { ...input.to, type: from.type };
  if (samePeriod(from, to)) return { error: "Las facturas ya están en ese lote: elige otro." };

  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: firmId, isUnclassifiedBucket: false },
    select: { id: true },
  });
  if (!client) return { error: "No tienes acceso a este cliente" };

  const lotWhere: Prisma.InvoiceWhereInput = {
    clientId,
    client: { advisoryFirmId: firmId },
    periodType: from.periodType,
    periodMonth: from.periodMonth,
    periodYear: from.periodYear,
    type: from.type,
  };

  try {
    return await moveInTransaction({ clientId, lotWhere, from, to, userId });
  } catch (e) {
    if (e instanceof StaleBatchError) {
      return { error: "No se ha movido ninguna factura: otra persona ha cambiado el lote. Recarga la página." };
    }
    throw e;
  }
}

async function moveInTransaction({ clientId, lotWhere, from, to, userId }: {
  clientId: string;
  lotWhere: Prisma.InvoiceWhereInput;
  from: BatchRef;
  to: BatchRef;
  userId: string;
}): Promise<MoveBatchResult> {
  return prisma.$transaction(async (tx): Promise<MoveBatchResult> => {
    const closures = await tx.periodClosure.findMany({
      where: {
        clientId,
        reopenedAt: null,
        OR: [
          { month: from.periodMonth, year: from.periodYear },
          { month: to.periodMonth, year: to.periodYear },
        ],
      },
      select: { month: true, year: true },
    });
    const closed = (period: BatchPeriod) =>
      closures.some((c) => c.month === period.periodMonth && c.year === period.periodYear);
    if (closed(from)) {
      return { error: `El periodo de este lote (${periodLabel(from.periodType, from.periodMonth, from.periodYear)}) está cerrado: pide a un administrador que lo reabra en Cierres antes de mover sus facturas.` };
    }
    if (closed(to)) {
      return { error: `El periodo de destino (${periodLabel(to.periodType, to.periodMonth, to.periodYear)}) está cerrado: pide a un administrador que lo reabra en Cierres o elige otro lote.` };
    }

    const rows = await tx.invoice.findMany({
      where: lotWhere,
      select: { id: true, status: true, splitFromId: true, _count: { select: { exportBatchItems: true } } },
    });
    const plan = planBatchMove(rows.map((r) => ({
      id: r.id,
      status: r.status,
      splitFromId: r.splitFromId,
      everExported: r._count.exportBatchItems > 0,
    })));
    if (plan.moveIds.length === 0) {
      return plan.stay > 0
        ? { error: "Todas las facturas de este lote ya salieron en un Excel: se quedan en él." }
        : { error: "Este lote ya no tiene facturas que mover. Recarga la página." };
    }

    // El lote y «nunca exportada» se repiten en la escritura: entre la lectura
    // y aquí otra persona puede haberlas movido o exportado. También el
    // puntero: si un export tiene la factura reservada, este UPDATE la espera
    // y, al confirmarse el export, Postgres vuelve a mirar la fila (y ve el
    // puntero) pero la subconsulta de ExportBatchItem sigue con la foto del
    // principio y no ve el item nuevo.
    const moved = await tx.invoice.updateManyAndReturn({
      where: {
        AND: [lotWhere, { id: { in: plan.moveIds }, status: { not: "EXPORTED" }, exportBatchId: null, exportBatchItems: { none: {} } }],
      },
      data: { periodType: to.periodType, periodMonth: to.periodMonth, periodYear: to.periodYear },
      select: { id: true, status: true },
    });
    const movidas = moved.filter((inv) => inv.status !== "SPLIT_SOURCE").length;
    if (movidas === 0) throw new StaleBatchError();

    await appendAuditLogs(
      moved.map((inv) => ({
        invoiceId: inv.id,
        userId,
        field: BATCH_AUDIT_FIELD,
        oldValue: batchLabel(from),
        newValue: batchLabel(to),
      })),
      tx,
    );
    return { movidas, quedan: plan.stay + (plan.moved - movidas) };
  }, AUDIT_TRANSACTION_OPTIONS);
}
