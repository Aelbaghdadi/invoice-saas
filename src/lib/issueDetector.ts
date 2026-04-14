import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { Invoice, IssueType } from "@prisma/client";

type IssueData = {
  type: IssueType;
  description: string;
  field?: string;
};

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Detects issues after OCR extraction and creates InvoiceIssue records.
 * Returns the list of issues created.
 */
export async function detectIssues(
  invoiceId: string,
  extraction: ExtractedInvoice,
  invoice: Invoice,
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
    const expected = extraction.taxBase + extraction.vatAmount;
    const diff = Math.abs(Math.round(expected * 100) - Math.round(extraction.totalAmount * 100));
    if (diff > 2) {
      issues.push({
        type: "MATH_MISMATCH",
        description: `El total (${extraction.totalAmount}) no coincide con Base + IVA (${expected.toFixed(2)}). Diferencia: ${(diff / 100).toFixed(2)}\u20AC.`,
      });
    }
  }

  // 4. POSSIBLE_DUPLICATE — functional dedup (non-blocking alert)
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
        select: { id: true, filename: true },
      });
      if (dupByNumber) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de "${dupByNumber.filename}" (misma factura ${extraction.invoiceNumber} de ${extraction.issuerCif}).`,
        });
      }
    }

    // Strategy B: CIF + total + date (only if Strategy A didn't match)
    if (
      !issues.some((i) => i.type === "POSSIBLE_DUPLICATE") &&
      extraction.totalAmount != null &&
      extraction.invoiceDate
    ) {
      const dupByFields = await prisma.invoice.findFirst({
        where: {
          ...baseWhere,
          totalAmount: extraction.totalAmount,
          invoiceDate: new Date(extraction.invoiceDate),
        },
        select: { id: true, filename: true },
      });
      if (dupByFields) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de "${dupByFields.filename}" (mismo CIF ${extraction.issuerCif}, total ${extraction.totalAmount} y fecha).`,
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
