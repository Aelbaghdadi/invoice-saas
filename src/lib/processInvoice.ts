import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  extractInvoiceFromXml,
} from "@/lib/ocr";

export async function processInvoice(invoiceId: string, triggeredByUserId: string) {
  // Atomic status transition: only proceed if status is still UPLOADED
  // This prevents double OCR processing if triggered concurrently
  const result = await prisma.invoice.updateMany({
    where: { id: invoiceId, status: "UPLOADED" },
    data:  { status: "ANALYZING" },
  });
  if (result.count === 0) return; // Already processing or processed

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  try {
    const supabase = createServerSupabase();
    if (!supabase) throw new Error("Storage not configured");

    let extracted;
    const ft = invoice.fileType;

    if (ft.includes("xml")) {
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      extracted = await extractInvoiceFromXml(await data.text());
    } else {
      // Download file as base64
      const { data, error } = await supabase.storage.from("invoices").download(invoice.storageKey);
      if (error) throw new Error(error.message);
      const buffer = await data.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      if (ft === "application/pdf" || invoice.filename.endsWith(".pdf")) {
        extracted = await extractInvoiceFromPdf(base64);
      } else {
        // image
        extracted = await extractInvoiceFromImage(base64, ft || "image/jpeg");
      }
    }

    // Math validation
    const { taxBase, vatAmount, irpfAmount, totalAmount } = extracted;
    let isValid: boolean | null = null;
    if (taxBase !== null && vatAmount !== null && totalAmount !== null) {
      const irpf = irpfAmount ?? 0;
      const diff = Math.abs(
        Math.round((taxBase + vatAmount - irpf) * 100) - Math.round(totalAmount * 100)
      );
      isValid = diff <= 2;
    }

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "ANALYZING",
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

    await prisma.auditLog.create({
      data: {
        invoiceId,
        userId: triggeredByUserId,
        field: "status",
        oldValue: "UPLOADED",
        newValue: "ANALYZING",
      },
    });
  } catch (err) {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "UPLOADED" } });
    console.error("OCR error:", err);
  }
}
