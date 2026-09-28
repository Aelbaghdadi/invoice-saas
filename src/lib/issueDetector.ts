import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice } from "@/lib/ocr";
import type { Invoice, IssueType } from "@prisma/client";
import { normalizeBusinessName, parseTaxId, type OperationTypeName } from "@/lib/validators";
import { formatEur } from "@/lib/format";
import { intracomVatIssue, mathIssues } from "@/lib/mathIssues";
import { findByInvoiceNumber } from "@/lib/duplicates";
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

  // 4. INTRACOM_VAT — intracomunitaria con IVA declarado (intracomVatIssue,
  // tambien en la clasificacion manual).
  const intracomVat = intracomVatIssue({
    lines: extraction.vatLines,
    vatAmount: extraction.vatAmount ?? null,
    vatRate: extraction.vatRate ?? null,
    operationType: operationTypeHint,
  });
  if (intracomVat) issues.push(intracomVat);

  // 5. POSSIBLE_DUPLICATE — functional dedup (non-blocking alert)
  // Strategy A: exact match by CIF + invoice number (strongest signal)
  // Strategy B: fuzzy match by CIF + total + date (catches re-scans / different PDFs)
  const baseWhere = {
    clientId: invoice.clientId,
    type: invoice.type,
    id: { not: invoiceId },
    status: { notIn: ["REJECTED" as const] },
  };

  // Mismo fichero (hash) ya subido a este cliente: duplicado seguro. La
  // subida normal ya lo frena, pero no la del buzon (aun sin cliente real)
  // ni un ticket sin NIF, numero ni nombre que las otras no pueden ver.
  if (invoice.fileHash) {
    const sameFile = await prisma.invoice.findFirst({
      where: { clientId: invoice.clientId, id: { not: invoiceId }, status: { notIn: ["REJECTED" as const] }, fileHash: invoice.fileHash },
      select: DUPLICATE_SELECT,
    });
    if (sameFile) {
      issues.push({
        type: "POSSIBLE_DUPLICATE",
        description: `Posible duplicado de ${describeExisting(sameFile)}: es el mismo fichero.`,
      });
    }
  }

  // CIF limpio, como se guarda (F-010): el crudo del OCR («ESB12345678»,
  // «B-12345678», «b12345678») no casaba con el de la BD.
  const issuerCif = parseTaxId(extraction.issuerCif).clean || null;

  // Strategy A: CIF + numero normalizado. En ventas basta el numero: el
  // cliente y el tipo ya fijan al emisor.
  const isSale = invoice.type === "SALE";
  if (extraction.invoiceNumber && (isSale || issuerCif) && !issues.some((i) => i.type === "POSSIBLE_DUPLICATE")) {
    const dupId = await findByInvoiceNumber({
      clientId: invoice.clientId, type: invoice.type, excludeId: invoiceId,
      invoiceNumber: extraction.invoiceNumber, issuerCif: isSale ? null : issuerCif,
    });
    const dupByNumber = dupId ? await prisma.invoice.findUnique({ where: { id: dupId }, select: DUPLICATE_SELECT }) : null;
    if (dupByNumber) {
      issues.push({
        type: "POSSIBLE_DUPLICATE",
        description: isSale
          ? `Posible duplicado de ${describeExisting(dupByNumber)}: mismo número de factura emitida.`
          : `Posible duplicado de ${describeExisting(dupByNumber)}: mismo número y mismo CIF emisor (${issuerCif}).`,
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
    const sameAmountAndDate = { ...baseWhere, totalAmount: extraction.totalAmount, invoiceDate: validDate };
    const total = formatEur(extraction.totalAmount);
    if (isSale) {
      // En ventas el emisor es el propio cliente: comparar su CIF sacaba como
      // duplicadas dos ventas del mismo importe y dia a clientes distintos.
      // Ahi se compara el destinatario, limpio como se guarda (revision 2 del
      // PR #7), aunque el OCR no haya leido el CIF del emisor.
      const saleReceiver = parseTaxId(extraction.receiverCif).clean || null;
      if (saleReceiver) {
        const dup = await prisma.invoice.findFirst({
          where: { ...sameAmountAndDate, receiverCif: saleReceiver },
          select: DUPLICATE_SELECT,
        });
        if (dup) {
          issues.push({
            type: "POSSIBLE_DUPLICATE",
            description: `Posible duplicado de ${describeExisting(dup)}: mismo destinatario (${saleReceiver}), total (${total}) y fecha.`,
          });
        }
      } else if (!extraction.invoiceNumber) {
        // Venta sin NIF ni numero: solo con el nombre del destinatario, no
        // vacio e igual en las dos (normalizado). Por importe y fecha a secas,
        // seis tickets distintos de 1,50 € del mismo dia salian como
        // duplicados; el mismo fichero dos veces ya lo coge el hash.
        const name = normalizeBusinessName(extraction.receiverName ?? "");
        const candidates = name
          ? await prisma.invoice.findMany({
              where: { ...sameAmountAndDate, receiverCif: null, receiverName: { not: null } },
              select: { ...DUPLICATE_SELECT, receiverName: true },
              take: 50,
            })
          : [];
        const dup = candidates.find((c) => normalizeBusinessName(c.receiverName ?? "") === name);
        if (dup) {
          issues.push({
            type: "POSSIBLE_DUPLICATE",
            description: `Posible duplicado de ${describeExisting(dup)}: venta sin NIF al mismo destinatario (${extraction.receiverName}), con el mismo total (${total}) y fecha.`,
          });
        }
      }
    } else if (issuerCif) {
      const dup = await prisma.invoice.findFirst({
        where: { ...sameAmountAndDate, issuerCif },
        select: DUPLICATE_SELECT,
      });
      if (dup) {
        issues.push({
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de ${describeExisting(dup)}: mismo CIF emisor (${issuerCif}), total (${total}) y fecha.`,
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
