import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import type { InvoiceStatus } from "@prisma/client";
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  extractInvoiceFromXml,
} from "@/lib/ocr";
import { detectIssues } from "@/lib/issueDetector";
import { appendAuditLogs } from "@/lib/auditLog";
import {
  parseTaxId,
  isPersonaFisica,
  RETENTION_DEFAULT_RATE,
  type RetentionTypeName,
} from "@/lib/validators";

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

    // Normalizacion de NIFs y deteccion de tipo de operacion a partir
    // del prefijo del NIF (parser en validators.ts para no tocar OCR).
    const issuerParsed   = parseTaxId(extracted.issuerCif);
    const receiverParsed = parseTaxId(extracted.receiverCif);

    // ── Auto-rellenado del cliente como parte conocida ─────────────────
    //
    // Cuando el gestor sube una factura para un cliente concreto:
    //  - PURCHASE (recibida) → el cliente es el RECEPTOR siempre
    //  - SALE    (emitida)   → el cliente es el EMISOR siempre
    //
    // Esos datos NO los necesita el OCR — los sabemos a priori. Forzamos
    // los campos del Client (nombre + CIF) ignorando lo que el OCR diga
    // de esa parte. El OCR solo es responsable de la "otra parte".
    const clientRecord = await prisma.client.findUnique({
      where: { id: invoice.clientId },
      select: { name: true, cif: true },
    });

    let finalIssuerName = extracted.issuerName;
    let finalIssuerCif  = issuerParsed.clean || null;
    let finalIssuerCountry = issuerParsed.countryCode;
    let finalReceiverName = extracted.receiverName;
    let finalReceiverCif  = receiverParsed.clean || null;

    if (clientRecord) {
      if (invoice.type === "PURCHASE") {
        finalReceiverName = clientRecord.name;
        finalReceiverCif  = clientRecord.cif;
      } else {
        finalIssuerName = clientRecord.name;
        finalIssuerCif  = clientRecord.cif;
        // Cliente es espanol por definicion (esta en una asesoria ES);
        // no le ponemos issuerCountry para que quede null = nacional.
        finalIssuerCountry = null;
      }
    }

    // ── operationType desde la "otra parte" ────────────────────────────
    //
    // Para PURCHASE miramos al emisor (proveedor): si es DE -> INTRACOM.
    // Para SALE miramos al receptor (cliente final): si es DE -> INTRACOM
    // tambien (entrega intracomunitaria). Antes solo miraba al issuer y
    // las SALE internacionales se marcaban mal.
    const otherParty = invoice.type === "PURCHASE" ? issuerParsed : receiverParsed;
    const otherPartyClean = otherParty.clean;

    // Aprendizaje por NIF: si ya hemos visto a esta otra parte en este
    // cliente y el gestor le asigno un operationType / retencion, lo
    // respetamos. Asi proveedores recurrentes (gestoria, abogado,
    // alquiler) se autoconfiguran desde la 2a factura.
    const knownEntry = otherPartyClean
      ? await prisma.accountEntry.findUnique({
          where: { clientId_nif: { clientId: invoice.clientId, nif: otherPartyClean } },
          select: {
            defaultOperationType: true,
            defaultRetentionType: true,
            defaultRetentionRate: true,
          },
        }).catch(() => null)
      : null;
    const operationType = knownEntry?.defaultOperationType ?? otherParty.operationType;

    // ── Deteccion de retencion IRPF ────────────────────────────────────
    //
    // Heuristica conservadora: si el emisor (en PURCHASE) es persona
    // fisica (DNI/NIE), sugerimos PROFESSIONAL al 15%. El gestor lo
    // ajusta si hace falta (a 7% para nuevos autonomos, o lo desactiva).
    // El aprendizaje por NIF tiene prioridad: si ya validamos antes una
    // factura de esta persona como RENT 19%, lo respetamos.
    let retentionType: RetentionTypeName | null =
      knownEntry?.defaultRetentionType ?? null;
    let retentionRate: number | null =
      knownEntry?.defaultRetentionRate != null ? Number(knownEntry.defaultRetentionRate) : null;

    // Sugerencia automatica: persona fisica como emisor en PURCHASE.
    // Para SALE no sugerimos retencion (es el cliente quien retiene a
    // sus proveedores, no al reves).
    if (!retentionType && invoice.type === "PURCHASE" && isPersonaFisica(issuerParsed.clean)) {
      retentionType = "PROFESSIONAL";
      retentionRate = RETENTION_DEFAULT_RATE.PROFESSIONAL;
    }

    // Calculamos cuota e importe de la base de retencion solo si hay
    // tipo. La base por defecto es la suma de bases imponibles del IVA.
    const sumBasesAll = vatLines.reduce((s, l) => s + l.taxBase, 0);
    const retentionBase = retentionType ? sumBasesAll : null;
    const computedIrpfAmount = retentionType && retentionRate != null
      ? parseFloat(((sumBasesAll * retentionRate) / 100).toFixed(2))
      : (extracted.irpfAmount ?? null);
    const finalIrpfRate = retentionRate ?? extracted.irpfRate ?? null;
    const finalIrpfAmount = computedIrpfAmount;

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
          issuerName:    finalIssuerName,
          issuerCif:     finalIssuerCif,
          issuerCountry: finalIssuerCountry,
          operationType,
          receiverName:  finalReceiverName,
          receiverCif:   finalReceiverCif,
          invoiceNumber: extracted.invoiceNumber,
          invoiceDate:   extracted.invoiceDate ? new Date(extracted.invoiceDate) : null,
          taxBase:       extracted.taxBase,
          vatRate:       extracted.vatRate ?? denormVatRate,
          vatAmount:     extracted.vatAmount,
          irpfRate:      finalIrpfRate,
          irpfAmount:    finalIrpfAmount,
          retentionType,
          retentionBase,
          totalAmount:   extracted.totalAmount,
          isValid,
          lastOcrError:  null,
        },
      }),
    ]);

    await transitionStatus(invoiceId, "ANALYZING", targetStatus, triggeredByUserId);

    await appendAuditLogs([{
      invoiceId,
      userId: triggeredByUserId,
      field: "status",
      oldValue: "UPLOADED",
      newValue: targetStatus,
    }]);
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
