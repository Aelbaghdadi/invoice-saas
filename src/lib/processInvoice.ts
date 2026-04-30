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

    let source: string;
    let ocrResult;
    const ft = invoice.fileType;

    if (ft.includes("xml")) {
      source = "xml_parse";
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      const xmlText = await data.text();
      ocrResult = await extractInvoiceFromXml(xmlText);
    } else {
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      const buffer = await data.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      if (ft === "application/pdf" || invoice.filename.endsWith(".pdf")) {
        source = "document_ai";
        ocrResult = await extractInvoiceFromPdf(base64);
      } else {
        source = "document_ai";
        ocrResult = await extractInvoiceFromImage(base64, ft || "image/jpeg");
      }
    }

    const extracted = ocrResult.extracted;
    // rawResponse ahora es la respuesta CRUDA del proveedor (entities +
    // text para Doc AI; XML literal para Facturae). Antes guardabamos el
    // resultado ya mapeado, lo cual no servia para debugging.
    const rawResponse = ocrResult.rawJson;

    // Math validation: Σ(bases) + Σ(cuotas) - IRPF = Total. Leave isValid=null
    // if total/lines incompletos asi el revisor se ve forzado a rellenar.
    const { taxBase, vatAmount, totalAmount, irpfAmount, vatLines } = extracted;
    let isValid: boolean | null = null;
    if (taxBase !== null && vatAmount !== null && totalAmount !== null) {
      const expected = taxBase + vatAmount - (irpfAmount ?? 0);
      const diff = Math.abs(
        Math.round(expected * 100) - Math.round(totalAmount * 100)
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

    // vatRate denormalizado: solo significativo cuando hay una unica linea.
    // Multi-IVA -> null (el desglose vive en InvoiceVatLine).
    const denormVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;

    // Copy OCR data to Invoice (datos finales — gestor los editará)
    await prisma.$transaction([
      // Reemplazar lineas previas (idempotente: si reproceso, borra y mete).
      prisma.invoiceVatLine.deleteMany({ where: { invoiceId } }),
      ...(vatLines.length > 0
        ? [prisma.invoiceVatLine.createMany({
            data: vatLines.map((l, i) => ({
              invoiceId,
              position:  i,
              taxBase:   l.taxBase,
              vatRate:   l.vatRate,
              vatAmount: l.vatAmount,
            })),
          })]
        : []),
      prisma.invoice.update({
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
          vatRate:       extracted.vatRate ?? denormVatRate,
          vatAmount:     extracted.vatAmount,
          irpfRate:      extracted.irpfRate,
          irpfAmount:    extracted.irpfAmount,
          totalAmount:   extracted.totalAmount,
          isValid,
          lastOcrError:  null,
        },
      }),
    ]);

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
