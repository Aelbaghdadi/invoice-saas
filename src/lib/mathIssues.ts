/**
 * Incidencias de cuadre de una factura: el total frente a Base + IVA +
 * Recargo - IRPF (tolerancia comun, F-058) y la cuota de cada linea frente a
 * su base × % (F-022). Sin dependencias: las usan el detector del OCR y la
 * clasificacion manual de «Por clasificar», que antes solo miraba duplicados
 * y dejaba en «Requiere atención» facturas sin incidencia que resolver.
 */
import type { IssueType } from "@prisma/client";
import { formatEur } from "@/lib/format";
import { invoiceBalanceDiffCents, isInvoiceBalanced } from "@/lib/invoiceBalance";
import { describeVatLineMismatch, vatLineMismatches, type CheckedLine } from "@/lib/vatLineChecks";

export type MathIssue = { type: IssueType; description: string; field?: string };

export function mathIssues(input: {
  lines: CheckedLine[];
  /** Totales de la factura; solo se usan si no hay lineas. */
  taxBase: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  irpfAmount: number | null;
  operationType?: string | null;
}): MathIssue[] {
  const issues: MathIssue[] = [];
  const { lines } = input;

  // Total: hace falta total y, sin lineas, la base y la cuota de la factura.
  if (input.totalAmount != null && (lines.length > 0 || (input.taxBase != null && input.vatAmount != null))) {
    const sumBase = lines.length > 0 ? lines.reduce((s, l) => s + l.taxBase, 0) : input.taxBase!;
    const sumAmount = lines.length > 0 ? lines.reduce((s, l) => s + l.vatAmount, 0) : input.vatAmount!;
    // El recargo de equivalencia suma al total igual que el IVA: sin el,
    // cualquier factura de un cliente en recargo salia como descuadrada.
    const sumSurcharge = lines.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0);
    const irpf = input.irpfAmount ?? 0;
    const balance = { sumBase, sumAmount, sumSurcharge, irpf, total: input.totalAmount };
    if (!isInvoiceBalanced(balance)) {
      const expected = sumBase + sumAmount + sumSurcharge - irpf;
      const diff = Math.abs(invoiceBalanceDiffCents(balance));
      const formula = `Base + IVA${sumSurcharge ? " + Rec. Equiv." : ""}${input.irpfAmount ? " - IRPF" : ""}`;
      issues.push({
        type: "MATH_MISMATCH",
        description: `El total (${formatEur(input.totalAmount)}) no coincide con ${formula} (${formatEur(expected)}). Diferencia: ${formatEur(diff / 100)}.`,
      });
    }
  }

  // Cuota por linea: el total puede cuadrar con las cuotas cruzadas entre
  // tipos. Es un aviso: la factura va a «Requiere atención».
  const lineMismatches = vatLineMismatches(lines, input.operationType);
  if (lineMismatches.length > 0) {
    issues.push({
      type: "MATH_MISMATCH",
      description: `El desglose por tipo no cuadra. ${lineMismatches.map(describeVatLineMismatch).join(". ")}.`,
    });
  }
  return issues;
}
