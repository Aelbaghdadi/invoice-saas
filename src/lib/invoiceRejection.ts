/**
 * Rechazar una factura: el mismo flujo desde la revision (rejectInvoice) y
 * desde «Es duplicada» del listado (quickRejectDuplicate). Antes el listado
 * solo miraba REJECTED y VALIDATED y escribia sin condicion: rechazaba una
 * exportada, una en analisis o una de un periodo cerrado, y avisaba al
 * cliente.
 *
 * El acceso lo comprueba quien llama (depende de la sesion); aqui va el
 * resto: exportada, estado de origen, periodo cerrado y la escritura
 * condicionada con incidencias (F-057), historial y auditoria.
 */
import { Prisma, type Invoice, type InvoiceStatus, type RejectionCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendAuditLogs } from "@/lib/auditLog";
import { appError, type AppError } from "@/lib/errorCodes";
import { EXPORT_TRANSACTION_OPTIONS } from "@/lib/exportBatch";
import { closeOpenIssues } from "@/lib/invoiceIssues";
import { reviewActionBlockReason, reviewAllowedFrom } from "@/lib/invoiceStatuses";
import { closedPeriodError, conditionalWriteError, invoicePeriod } from "@/lib/reviewGuards";
import { notifyClientInvoiceRejected } from "@/lib/email";

export type RejectInput = {
  invoiceId: string;
  userId: string;
  reason: string;
  category: RejectionCategory | null;
  /** Acceso de la sesion al cliente de la factura: { error } o null. */
  authorize: (clientId: string) => Promise<{ error: string } | null>;
  /** Estados de origen mas estrictos que los de rechazar (se intersectan
   *  con reviewAllowedFrom("reject")), con el error si no esta en ellos. */
  allowedFrom?: { statuses: InvoiceStatus[]; error: string };
};

/** La factura tal como estaba antes de rechazarla, o por que no se rechaza. */
export async function rejectInvoiceCore(input: RejectInput): Promise<{ error: string | AppError } | { invoice: Invoice }> {
  const { invoiceId: id, userId, reason, category } = input;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: { exportBatchItems: { take: 1, select: { id: true } } },
  });
  if (!invoice) return { error: "Factura no encontrada" };

  const accessErr = await input.authorize(invoice.clientId);
  if (accessErr) return accessErr;

  // Con las flechas se llega a facturas ya terminadas. Una que ya salio en un
  // Excel esta en la contabilidad de A3: rechazarla aqui no la quita de alli
  // y al cliente le llegaria un rechazo de algo ya contabilizado.
  if (invoice.exportBatchItems.length > 0) {
    return { error: "Esta factura ya se exportó a A3 y no se puede rechazar. Si hay que corregirla, corrígela y vuelve a exportarla." };
  }
  // Ya rechazada, en analisis, dividida o por clasificar: no se rechaza. Se
  // repite en el propio updateMany de abajo.
  const blocked = reviewActionBlockReason(invoice.status, "reject");
  if (blocked) return { error: blocked };
  // «Es duplicada» del listado solo con la factura por revisar: si otro gestor
  // la valido mientras tanto, no se deshace su validacion. Tambien en el
  // updateMany.
  const allowedStatuses = reviewAllowedFrom("reject")
    .filter((s) => !input.allowedFrom || input.allowedFrom.statuses.includes(s));
  if (input.allowedFrom && !allowedStatuses.includes(invoice.status)) return { error: input.allowedFrom.error };
  const periodErr = await closedPeriodError(invoice.clientId, [invoicePeriod(invoice)], "rechazar");
  if (periodErr) return periodErr;

  // Condicionado al updatedAt leido: si una exportacion la reservo mientras
  // tanto, no se rechaza una factura que ya esta camino de A3 (F-049).
  // Estado, incidencias (F-057), historial y auditoria en una transaccion.
  // Con el timeout del export, como en parseAndSave: si un export tiene la
  // fila reservada, el updateMany espera a su COMMIT y con los 5 s por
  // defecto caducaba (P2028) y la accion lanzaba.
  let rejectedOk: boolean;
  try {
    rejectedOk = await prisma.$transaction(async (tx) => {
      const rejected = await tx.invoice.updateMany({
        where: { id, updatedAt: invoice.updatedAt, status: { in: allowedStatuses } },
        data: {
          status: "REJECTED",
          rejectionReason: reason,
          ...(category ? { rejectionCategory: category } : {}),
        },
      });
      if (rejected.count === 0) return false;
      await closeOpenIssues(tx, id, userId);
      await tx.invoiceStatusHistory.create({
        data: { invoiceId: id, fromStatus: invoice.status, toStatus: "REJECTED", changedBy: userId, reason },
      });
      await appendAuditLogs([{
        invoiceId: id,
        userId,
        field: "status",
        oldValue: invoice.status,
        newValue: "REJECTED",
      }], tx);
      return true;
    }, { timeout: EXPORT_TRANSACTION_OPTIONS.timeout + 5_000, maxWait: 5_000 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028") {
      return { error: appError("ERR-VALIDATE-003", `P2028 al rechazar: ${err.message}`) };
    }
    console.error(`[reject] no se pudo rechazar la factura ${id}:`, err);
    return { error: appError("ERR-SYS-001", `rechazar ${id}: ${err instanceof Error ? err.message : String(err)}`) };
  }
  if (!rejectedOk) {
    if (input.allowedFrom) {
      const now = await prisma.invoice.findUnique({ where: { id }, select: { status: true } });
      if (now && reviewActionBlockReason(now.status, "reject") == null && !allowedStatuses.includes(now.status)) {
        return { error: input.allowedFrom.error };
      }
    }
    return conditionalWriteError(id, "reject", {}, `updatedAt=${invoice.updatedAt.getTime()} al rechazar`);
  }
  return { invoice };
}

/** Correo al cliente con el motivo. Para after(): no lanza nunca. */
export async function notifyRejection(invoiceId: string, reason: string): Promise<void> {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { client: { include: { user: { select: { email: true } } } } },
    });
    if (inv?.client?.user?.email) {
      await notifyClientInvoiceRejected({
        clientEmail: inv.client.user.email,
        clientName: inv.client.name,
        invoiceNumber: inv.invoiceNumber ?? "",
        filename: inv.filename,
        reason,
      });
    }
  } catch (e) {
    console.error(`[NOTIFY] rechazo de ${invoiceId}:`, e);
  }
}
