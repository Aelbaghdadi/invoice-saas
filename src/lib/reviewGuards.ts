/**
 * Comprobaciones comunes de las escrituras de la revision (guardar, validar,
 * rechazar, dividir). Sin imports de Next: las usan las server actions de la
 * revision y el nucleo de rechazar (invoiceRejection).
 */
import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appError, type AppError } from "@/lib/errorCodes";
import { reviewActionBlockReason, reviewTargetBlockReason, type ReviewAction } from "@/lib/invoiceStatuses";

/** Periodo en el que cuenta la factura: el contable si lo tiene, si no el del
 *  lote. Mismo criterio que la pagina de revision y que parseAndSave. */
export function invoicePeriod(
  invoice: Pick<Invoice, "periodMonth" | "periodYear" | "accountingPeriodMonth" | "accountingPeriodYear">,
): { month: number; year: number } {
  return {
    month: invoice.accountingPeriodMonth ?? invoice.periodMonth,
    year: invoice.accountingPeriodYear ?? invoice.periodYear,
  };
}

/** Rechazar y dividir cambian la factura igual que guardar: con el periodo
 *  cerrado no se tocan (mismo criterio que rejectBatch). La pagina ya oculta
 *  los botones, pero puede estar abierta desde antes del cierre. */
export async function closedPeriodError(
  clientId: string,
  periods: { month: number; year: number }[],
  action: string,
): Promise<{ error: string } | null> {
  const seen = new Set<string>();
  for (const { month, year } of periods) {
    const key = `${month}/${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const closure = await prisma.periodClosure.findUnique({
      where: { clientId_month_year: { clientId, month, year } },
      select: { reopenedAt: true },
    });
    if (closure && !closure.reopenedAt) {
      return { error: `El periodo ${key} está cerrado: pide a un administrador que lo reabra en Cierres antes de ${action} la factura.` };
    }
  }
  return null;
}

/**
 * La escritura condicionada no ha tocado nada (count 0). Si la factura esta
 * ahora en un estado en el que la accion no vale, se dice por que; si no, es
 * que la cambio otra persona (ERR-VALIDATE-003).
 */
export async function conditionalWriteError(
  invoiceId: string,
  action: ReviewAction,
  options: { reopen?: boolean },
  detail: string,
): Promise<{ error: string | AppError }> {
  const now = await prisma.invoice
    .findUnique({
      where: { id: invoiceId },
      select: { status: true, replacedBy: { select: { id: true } }, client: { select: { isUnclassifiedBucket: true } } },
    })
    .catch(() => null);
  const reason = now
    ? reviewActionBlockReason(now.status, action, options)
      ?? reviewTargetBlockReason(action, {
        replacedById: now.replacedBy?.id ?? null,
        isUnclassifiedBucket: now.client.isUnclassifiedBucket,
      }, options)
    : null;
  return { error: reason ?? appError("ERR-VALIDATE-003", detail) };
}
