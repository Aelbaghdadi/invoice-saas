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

/** `field` de la incidencia de desglose por tipo: sin migracion (el tipo
 *  sigue siendo MATH_MISMATCH), pero la lista de incidencias la ensena como
 *  aviso y no como el error matematico del total. */
export const VAT_LINES_ISSUE_FIELD = "vatLines";

/** ¿Es el aviso de desglose por tipo (y no el descuadre del total)? */
export function isVatLinesIssue(issue: { type: string; field?: string | null }): boolean {
  return issue.type === "MATH_MISMATCH" && issue.field === VAT_LINES_ISSUE_FIELD;
}

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
      field: VAT_LINES_ISSUE_FIELD,
      description: `El desglose por tipo no cuadra. ${lineMismatches.map(describeVatLineMismatch).join(". ")}.`,
    });
  }
  return issues;
}

/**
 * Operacion intracomunitaria (adquisicion/entrega) con IVA declarado. Van
 * con IVA 0%; si el OCR deja el 21% por defecto del documento, no puede
 * colarse hasta el export. Es un aviso (NEEDS_ATTENTION) y no un 0% forzado
 * a ciegas: puede ser un error real del proveedor que el gestor deba ver. Lo
 * usan el detector del OCR y la clasificacion manual de «Por clasificar».
 */
export function intracomVatIssue(input: {
  lines: { vatRate: number; vatAmount: number }[];
  /** Cuota y % de la factura; solo se usan si no hay lineas. */
  vatAmount: number | null;
  vatRate: number | null;
  operationType?: string | null;
}): MathIssue | null {
  if (input.operationType !== "INTRACOM" && input.operationType !== "INTRACOM_SERVICIOS") return null;
  const { lines } = input;
  const sumVat = lines.length > 0 ? lines.reduce((s, l) => s + l.vatAmount, 0) : (input.vatAmount ?? 0);
  if (Math.abs(sumVat) <= 0.01) return null;
  const rate = lines.length === 1 ? lines[0].vatRate : input.vatRate;
  return {
    type: "MANUAL",
    description: `Operación intracomunitaria con IVA declarado${rate != null ? ` (${rate}%)` : ""}: las intracomunitarias suelen ir con IVA 0%. Revisa el desglose antes de exportar.`,
    field: "vatRate",
  };
}
