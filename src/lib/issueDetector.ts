import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { Invoice, IssueType } from "@prisma/client";
import { parseTaxId, type OperationTypeName } from "@/lib/validators";
import { formatEur } from "@/lib/format";
import { mathIssues } from "@/lib/mathIssues";
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
 * `operationTypeHint` es el tipo de operacion que processInvoice va a guardar
 * (el aprendido del tercero o, si no hay, el del prefijo del NIF). Decide si
 * se avisa de IVA no-cero en intracomunitarias y si se comprueba la cuota por
 * linea (no en inversion del sujeto pasivo). No se persiste aqui.
 */
export async function detectIssues(
  invoiceId: string,
  extraction: ExtractedInvoice,
  invoice: Invoice,
  operationTypeHint?: OperationTypeName,
  // Con false solo las devuelve: el OCR las guarda el mismo en su escritura
  // final, que no se hace si la factura ha cambiado mientras analizaba.
  options: { persist?: boolean } = {},
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

  // 3. Cuadre del total y 3b. cuota por linea (mathIssues, tambien en la
  // clasificacion manual). El total solo si el OCR leyo base, cuota y total.
  if (extraction.taxBase != null && extraction.vatAmount != null && extraction.totalAmount != null) {
    issues.push(...mathIssues({
      lines: extraction.vatLines,
      taxBase: extraction.taxBase,
      vatAmount: extraction.vatAmount,
      totalAmount: extraction.totalAmount,
      irpfAmount: extraction.irpfAmount ?? null,
      operationType: operationTypeHint,
    }));
  } else {
    issues.push(...mathIssues({
      lines: extraction.vatLines, taxBase: null, vatAmount: null, totalAmount: null, irpfAmount: null,
      operationType: operationTypeHint,
    }));
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
      // En ventas el emisor es el propio cliente: comparar su CIF sacaba como
      // duplicadas dos ventas del mismo importe y dia a clientes distintos.
      // Ahi se compara el destinatario, limpio como se guarda (revision 2 del
      // PR #7).
      const isSale = invoice.type === "SALE";
      const saleReceiver = isSale ? parseTaxId(extraction.receiverCif).clean || null : null;
      const dupByFields = isSale && !saleReceiver
        ? null
        : await prisma.invoice.findFirst({
            where: {
              ...(isSale ? { ...baseWhere, issuerCif: undefined, receiverCif: saleReceiver } : baseWhere),
              totalAmount: extraction.totalAmount,
              invoiceDate: validDate,
            },
            select: DUPLICATE_SELECT,
          });
      if (dupByFields) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: isSale
            ? `Posible duplicado de ${describeExisting(dupByFields)}: mismo destinatario (${saleReceiver}), total (${formatEur(extraction.totalAmount)}) y fecha.`
            : `Posible duplicado de ${describeExisting(dupByFields)}: mismo CIF emisor (${extraction.issuerCif}), total (${formatEur(extraction.totalAmount)}) y fecha.`,
        });
      }
    }
  }

  // Create all issues in database
  if (issues.length > 0 && options.persist !== false) {
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
