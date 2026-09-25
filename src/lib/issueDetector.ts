import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { Invoice, IssueType } from "@prisma/client";
import type { OperationTypeName } from "@/lib/validators";
import { formatEur } from "@/lib/format";
import { formatDateEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";

type IssueData = {
  type: IssueType;
  description: string;
  field?: string;
};

const CONFIDENCE_THRESHOLD = 0.7;

export const DUPLICATE_SELECT = {
  invoiceNumber: true,
  filename: true,
  createdAt: true,
  periodType: true,
  periodMonth: true,
  periodYear: true,
} as const;

/** La factura ya registrada en el aviso de duplicado: numero, fecha de subida
 *  y periodo. Con el nombre del fichero a secas, si se subia el mismo PDF dos
 *  veces el aviso repetia el nombre del propio fichero y no decia cual era. */
export function describeExisting(existing: {
  invoiceNumber: string | null;
  filename: string;
  createdAt: Date;
  periodType: "MONTHLY" | "QUARTERLY";
  periodMonth: number;
  periodYear: number;
}): string {
  const ref = existing.invoiceNumber ?? `«${existing.filename}»`;
  const period = periodLabel(existing.periodType, existing.periodMonth, existing.periodYear);
  return `la factura ${ref} subida el ${formatDateEs(existing.createdAt)} (${period})`;
}

/**
 * Detects issues after OCR extraction and creates InvoiceIssue records.
 * Returns the list of issues created.
 *
 * `operationTypeHint` es una pista (derivada del prefijo del NIF de la otra
 * parte, ver processInvoice) de si la factura es intracomunitaria — se usa
 * SOLO para decidir si avisar de IVA no-cero, no se persiste aqui.
 */
export async function detectIssues(
  invoiceId: string,
  extraction: ExtractedInvoice,
  invoice: Invoice,
  operationTypeHint?: OperationTypeName,
): Promise<IssueData[]> {
  const issues: IssueData[] = [];

  // 1. OCR_FAILED — all key fields are null
  const keyFields = [
    extraction.issuerName, extraction.issuerCif,
    extraction.invoiceNumber, extraction.totalAmount,
  ];
  if (keyFields.every((f) => f == null)) {
    issues.push({
      type: "OCR_FAILED",
      description: "No se pudieron extraer los campos principales de la factura.",
    });
  }

  // 2. LOW_CONFIDENCE — any field below threshold
  if (extraction.confidence) {
    const fieldLabels: Record<string, string> = {
      issuerName: "Nombre emisor",
      issuerCif: "CIF emisor",
      receiverName: "Nombre receptor",
      receiverCif: "CIF receptor",
      invoiceNumber: "N\u00ba factura",
      invoiceDate: "Fecha",
      taxBase: "Base imponible",
      vatRate: "% IVA",
      vatAmount: "Cuota IVA",
      irpfRate: "% IRPF",
      irpfAmount: "Cuota IRPF",
      totalAmount: "Total",
    };

    for (const [field, score] of Object.entries(extraction.confidence)) {
      if (score < CONFIDENCE_THRESHOLD && score > 0) {
        issues.push({
          type: "LOW_CONFIDENCE",
          description: `Campo "${fieldLabels[field] ?? field}" con baja confianza OCR (${Math.round(score * 100)}%).`,
          field,
        });
      }
    }
  }

  // 3. MATH_MISMATCH — tax calculation doesn't match
  if (
    extraction.taxBase != null &&
    extraction.vatAmount != null &&
    extraction.totalAmount != null
  ) {
    const sumBases = extraction.vatLines.length > 0
      ? extraction.vatLines.reduce((s, l) => s + l.taxBase, 0)
      : extraction.taxBase;
    const sumAmounts = extraction.vatLines.length > 0
      ? extraction.vatLines.reduce((s, l) => s + l.vatAmount, 0)
      : extraction.vatAmount;
    // El recargo de equivalencia suma al total igual que el IVA: sin el,
    // cualquier factura de un cliente en recargo salia como descuadrada.
    const sumSurcharge = extraction.vatLines.reduce(
      (s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0);
    const expected = sumBases + sumAmounts + sumSurcharge - (extraction.irpfAmount ?? 0);
    const diff = Math.abs(Math.round(expected * 100) - Math.round(extraction.totalAmount * 100));
    if (diff > 2) {
      const formula = `Base + IVA${sumSurcharge ? " + Rec. Equiv." : ""}${extraction.irpfAmount ? " - IRPF" : ""}`;
      issues.push({
        type: "MATH_MISMATCH",
        description: `El total (${formatEur(extraction.totalAmount)}) no coincide con ${formula} (${formatEur(expected)}). Diferencia: ${formatEur(diff / 100)}.`,
      });
    }
  }

  // 4. INTRACOM_VAT — operacion intracomunitaria (adquisicion/entrega) con
  // IVA declarado. Las intracomunitarias van con IVA 0%; si el OCR deja el
  // 21% por defecto del documento, no puede colarse silenciosamente hasta
  // el export. Se avisa aqui (NEEDS_ATTENTION) en vez de forzar el 0% a
  // ciegas: puede ser un error real del proveedor que el gestor deba ver.
  if (operationTypeHint === "INTRACOM" || operationTypeHint === "INTRACOM_SERVICIOS") {
    const sumVat = extraction.vatLines.length > 0
      ? extraction.vatLines.reduce((s, l) => s + l.vatAmount, 0)
      : (extraction.vatAmount ?? 0);
    if (Math.abs(sumVat) > 0.01) {
      const rate = extraction.vatLines.length === 1 ? extraction.vatLines[0].vatRate : extraction.vatRate;
      issues.push({
        type: "MANUAL",
        description: `Operación intracomunitaria con IVA declarado${rate != null ? ` (${rate}%)` : ""}: las intracomunitarias suelen ir con IVA 0%. Revisa el desglose antes de exportar.`,
        field: "vatRate",
      });
    }
  }

  // 5. POSSIBLE_DUPLICATE — functional dedup (non-blocking alert)
  // Strategy A: exact match by CIF + invoice number (strongest signal)
  // Strategy B: fuzzy match by CIF + total + date (catches re-scans / different PDFs)
  if (extraction.issuerCif) {
    const baseWhere = {
      clientId: invoice.clientId,
      issuerCif: extraction.issuerCif,
      type: invoice.type,
      id: { not: invoiceId },
      status: { notIn: ["REJECTED" as const] },
    };

    // Strategy A: CIF + invoice number
    if (extraction.invoiceNumber) {
      const dupByNumber = await prisma.invoice.findFirst({
        where: { ...baseWhere, invoiceNumber: extraction.invoiceNumber },
        select: DUPLICATE_SELECT,
      });
      if (dupByNumber) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de ${describeExisting(dupByNumber)}: mismo número y mismo CIF emisor (${extraction.issuerCif}).`,
        });
      }
    }

    // Strategy B: CIF + total + date (only if Strategy A didn't match).
    // Protegemos la fecha: el OCR a veces devuelve un RANGO (facturas de
    // suministros, p.ej. "14-jul-25 / 10-set-25") que produce un Date inválido,
    // y Prisma lo rechaza con un error crudo que dejaba la factura en Error OCR
    // sin posible recuperación. Si no es parseable, saltamos esta estrategia.
    const parsedDate = extraction.invoiceDate ? new Date(extraction.invoiceDate) : null;
    const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null;
    if (
      !issues.some((i) => i.type === "POSSIBLE_DUPLICATE") &&
      extraction.totalAmount != null &&
      validDate
    ) {
      const dupByFields = await prisma.invoice.findFirst({
        where: {
          ...baseWhere,
          totalAmount: extraction.totalAmount,
          invoiceDate: validDate,
        },
        select: DUPLICATE_SELECT,
      });
      if (dupByFields) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de ${describeExisting(dupByFields)}: mismo CIF emisor (${extraction.issuerCif}), total (${formatEur(extraction.totalAmount)}) y fecha.`,
        });
      }
    }
  }

  // Create all issues in database
  if (issues.length > 0) {
    await prisma.invoiceIssue.createMany({
      data: issues.map((issue) => ({
        invoiceId,
        type: issue.type,
        description: issue.description,
        field: issue.field ?? null,
      })),
    });
  }

  return issues;
}
