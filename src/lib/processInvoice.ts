import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import type { InvoiceStatus } from "@prisma/client";
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  extractInvoiceFromXml,
} from "@/lib/ocr";
import { detectIssues } from "@/lib/issueDetector";

/** Transition status + record in history */
async function transitionStatus(
  invoiceId: string,
  from: InvoiceStatus | null,
  to: InvoiceStatus,
  changedBy: string,
  reason?: string,
) {
  await prisma.invoiceStatusHistory.create({
    data: { invoiceId, fromStatus: from, toStatus: to, changedBy, reason },
  });
}

export async function processInvoice(invoiceId: string, triggeredByUserId: string) {
  // Atomic status transition: only proceed if status is still UPLOADED
  const result = await prisma.invoice.updateMany({
    where: { id: invoiceId, status: "UPLOADED" },
    data: { status: "ANALYZING", ocrAttempts: { increment: 1 } },
  });
  if (result.count === 0) return;

  await transitionStatus(invoiceId, "UPLOADED", "ANALYZING", triggeredByUserId);

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  const ocrStartedAt = new Date();

  try {
    const supabase = createServerSupabase();
    if (!supabase) throw new Error("Storage not configured");

    let extracted;
    let source: string;
    let rawResponse: string | undefined;
    const ft = invoice.fileType;

    if (ft.includes("xml")) {
      source = "xml_parse";
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      const xmlText = await data.text();
      rawResponse = xmlText;
      extracted = await extractInvoiceFromXml(xmlText);
    } else {
      // Download file as base64
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      const buffer = await data.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      if (ft === "application/pdf" || invoice.filename.endsWith(".pdf")) {
        source = "document_ai";
        extracted = await extractInvoiceFromPdf(base64);
      } else {
        source = "document_ai";
        extracted = await extractInvoiceFromImage(base64, ft || "image/jpeg");
      }
      rawResponse = JSON.stringify(extracted);
    }

    // Math validation: Base + IVA = Total
    const { taxBase, vatAmount, totalAmount } = extracted;
    let isValid: boolean | null = null;
    if (taxBase !== null && vatAmount !== null && totalAmount !== null) {
      const diff = Math.abs(
        Math.round((taxBase + vatAmount) * 100) - Math.round(totalAmount * 100)
      );
      isValid = diff <= 2;
    }

    // Save extraction as separate record (datos brutos OCR + job tracking)
    const ocrFinishedAt = new Date();
    const ocrDurationMs = ocrFinishedAt.getTime() - ocrStartedAt.getTime();
    const isReprocess = invoice.ocrAttempts > 1;

    await prisma.invoiceExtraction.create({
      data: {
        invoiceId,
        source,
        rawResponse,
        confidence: extracted.confidence ?? undefined,
        ocrStartedAt,
        ocrFinishedAt,
        ocrDurationMs,
        isReprocess,
        issuerName:    extracted.issuerName,
        issuerCif:     extracted.issuerCif,
        receiverName:  extracted.receiverName,
        receiverCif:   extracted.receiverCif,
        invoiceNumber: extracted.invoiceNumber,
        invoiceDate:   extracted.invoiceDate ? new Date(extracted.invoiceDate) : null,
        taxBase:       extracted.taxBase,
        vatRate:       extracted.vatRate,
        vatAmount:     extracted.vatAmount,
        irpfRate:      extracted.irpfRate,
        irpfAmount:    extracted.irpfAmount,
        totalAmount:   extracted.totalAmount,
        isValid,
      },
    });

    // Detect issues (duplicates, low confidence, math mismatch, etc.)
    const issues = await detectIssues(invoiceId, extracted, invoice);
    const targetStatus: InvoiceStatus = issues.length > 0 ? "NEEDS_ATTENTION" : "PENDING_REVIEW";

    // Copy OCR data to Invoice (datos finales — gestor los editará)
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: targetStatus,
        issuerName:    extracted.issuerName,
        issuerCif:     extracted.issuerCif,
        receiverName:  extracted.receiverName,
        receiverCif:   extracted.receiverCif,
        invoiceNumber: extracted.invoiceNumber,
        invoiceDate:   extracted.invoiceDate ? new Date(extracted.invoiceDate) : null,
        taxBase:       extracted.taxBase,
        vatRate:       extracted.vatRate,
        vatAmount:     extracted.vatAmount,
        irpfRate:      extracted.irpfRate,
        irpfAmount:    extracted.irpfAmount,
        totalAmount:   extracted.totalAmount,
        isValid,
        lastOcrError:  null,
      },
    });

    await transitionStatus(invoiceId, "ANALYZING", targetStatus, triggeredByUserId);

    await prisma.auditLog.create({
      data: {
        invoiceId,
        userId: triggeredByUserId,
        field: "status",
        oldValue: "UPLOADED",
        newValue: targetStatus,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "OCR_ERROR", lastOcrError: errorMsg },
    });
    await transitionStatus(invoiceId, "ANALYZING", "OCR_ERROR", triggeredByUserId, errorMsg);
    console.error("OCR error:", err);
  }
}
