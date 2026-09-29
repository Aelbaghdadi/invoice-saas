import type { InvoiceStatus } from "@prisma/client";
import type { PeriodTypeName } from "@/lib/period";

const QUARTER_START_MONTHS = [1, 4, 7, 10];

/** Las que no cuentan para decidirlo: una rechazada (una trimestral subida
 *  por error) y la original de una division. */
const NOT_COUNTED: InvoiceStatus[] = ["REJECTED", "SPLIT_SOURCE"];

/**
 * ¿El cierre de este mes es de un trimestre? El cierre solo guarda el mes:
 * un T3 subido en trimestral se cierra con month=7. Trimestral si el mes
 * empieza trimestre y alguna factura que cuenta del periodo es trimestral.
 * Lo usan el «Exportar» de Cierres y el resumen del cierre al cliente, para
 * que no discrepen (revision 1 del PR #14, punto 14).
 */
export function closurePeriodType(
  month: number,
  invoices: { status: InvoiceStatus; periodType: PeriodTypeName }[],
): PeriodTypeName {
  const quarterly = QUARTER_START_MONTHS.includes(month)
    && invoices.some((i) => i.periodType === "QUARTERLY" && !NOT_COUNTED.includes(i.status));
  return quarterly ? "QUARTERLY" : "MONTHLY";
}
