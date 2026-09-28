import { prisma } from "@/lib/prisma";
import { notifyClientPeriodSummary } from "@/lib/email";
import { PENDING_WORK } from "@/lib/invoiceStatuses";
import { closurePeriodType } from "@/lib/closurePeriodType";

/**
 * Correo de resumen al cliente al cerrar un periodo (F-040): validadas,
 * rechazadas con su motivo y pendientes. Para after(): no lanza nunca.
 */
export async function sendPeriodSummary(clientId: string, month: number, year: number): Promise<void> {
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, isUnclassifiedBucket: true, user: { select: { email: true } } },
    });
    if (!client?.user?.email || client.isUnclassifiedBucket) return;
    const invoices = await prisma.invoice.findMany({
      where: { clientId, periodMonth: month, periodYear: year, status: { notIn: ["SPLIT_SOURCE", "PENDING_ROUTING"] } },
      select: { status: true, periodType: true, invoiceNumber: true, filename: true, rejectionReason: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (invoices.length === 0) return;
    await notifyClientPeriodSummary({
      clientEmail: client.user.email,
      clientName: client.name,
      // Mismo criterio que el «Exportar» de Cierres: una T3 rechazada no hace
      // trimestral el cierre de julio (revision 1 del PR #14, punto 14).
      periodType: closurePeriodType(month, invoices),
      periodMonth: month,
      periodYear: year,
      validated: invoices.filter((i) => i.status === "VALIDATED" || i.status === "EXPORTED").length,
      rejected: invoices
        .filter((i) => i.status === "REJECTED")
        .map((i) => ({ ref: i.invoiceNumber || i.filename, reason: i.rejectionReason || "Sin motivo" })),
      pending: invoices.filter((i) => PENDING_WORK.includes(i.status)).length,
    });
  } catch (err) {
    console.error(`[NOTIFY] resumen del periodo ${month}/${year} de ${clientId}:`, err);
  }
}
