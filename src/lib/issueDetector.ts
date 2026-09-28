import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { Invoice, IssueType } from "@prisma/client";
import type { OperationTypeName } from "@/lib/validators";
import { intracomVatIssue, mathIssues } from "@/lib/mathIssues";
import { duplicateField, findPossibleDuplicate } from "@/lib/duplicates";

type IssueData = {
  type: IssueType;
  description: string;
  field?: string;
};

const CONFIDENCE_THRESHOLD = 0.7;

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

  // 4. INTRACOM_VAT — intracomunitaria con IVA declarado (intracomVatIssue,
  // tambien en la clasificacion manual).
  const intracomVat = intracomVatIssue({
    lines: extraction.vatLines,
    vatAmount: extraction.vatAmount ?? null,
    vatRate: extraction.vatRate ?? null,
    operationType: operationTypeHint,
  });
  if (intracomVat) issues.push(intracomVat);

  // 5. POSSIBLE_DUPLICATE — la misma comprobacion que al clasificar a mano
  // (src/lib/duplicates.ts).
  const duplicate = await findPossibleDuplicate({
    invoiceId,
    clientId: invoice.clientId,
    type: invoice.type,
    invoiceNumber: extraction.invoiceNumber,
    issuerCif: extraction.issuerCif,
    receiverCif: extraction.receiverCif,
    receiverName: extraction.receiverName,
    totalAmount: extraction.totalAmount,
    invoiceDate: extraction.invoiceDate,
    fileHash: invoice.fileHash,
  });
  if (duplicate) issues.push({ type: "POSSIBLE_DUPLICATE", description: duplicate.description, field: duplicateField(duplicate.originalId) });

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
