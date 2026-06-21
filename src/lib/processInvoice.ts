import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import type { InvoiceStatus } from "@prisma/client";
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  extractInvoiceFromXml,
} from "@/lib/ocr";
import {
  extractFromPdfTextWithGemini,
  extractFromDocumentWithGemini,
} from "@/lib/ocrLlm";
import { detectIssues } from "@/lib/issueDetector";
import { appendAuditLogs } from "@/lib/auditLog";
import {
  parseTaxId,
  isPersonaFisica,
  RETENTION_DEFAULT_RATE,
  type RetentionTypeName,
} from "@/lib/validators";
import { textMentionsRectificative, applyRectificativeSign } from "@/lib/rectificative";
import { routeByCif, clientSideCif, routeByText } from "@/lib/invoiceRouting";
import { lookupProviderClient } from "@/lib/providerRouting";

/**
 * Convierte el string de fecha del OCR a Date. Si el OCR devuelve algo
 * imparseable (p.ej. un rango "14-jul-25/10-set-25" en facturas de
 * suministros) devolvemos null en vez de un Date inválido — Prisma
 * lo rechaza con `Provided Date object is invalid`. Mejor guardar null
 * y que el gestor la complete a mano.
 */
function safeParseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d;
}

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
        if (process.env.GEMINI_API_KEY) {
          try {
            source = "gemini_text";
            ocrResult = await extractFromPdfTextWithGemini(base64);
          } catch (e) {
            if (e instanceof Error && e.message === "PDF_ESCANEADO") {
              source = "gemini_multimodal";
              ocrResult = await extractFromDocumentWithGemini(base64, "application/pdf");
            } else {
              throw e;
            }
          }
        } else {
          source = "document_ai";
          ocrResult = await extractInvoiceFromPdf(base64);
        }
      } else {
        if (process.env.GEMINI_API_KEY) {
          source = "gemini_multimodal";
          ocrResult = await extractFromDocumentWithGemini(base64, ft || "image/jpeg");
        } else {
          source = "document_ai";
          ocrResult = await extractInvoiceFromImage(base64, ft || "image/jpeg");
        }
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
        invoiceDate:   safeParseDate(extracted.invoiceDate),
        taxBase:       extracted.taxBase,
        vatRate:       extracted.vatRate,
        vatAmount:     extracted.vatAmount,
        irpfRate:      extracted.irpfRate,
        irpfAmount:    extracted.irpfAmount,
        totalAmount:   extracted.totalAmount,
        isValid,
      },
    });

    // ── Auto-ruteo multicliente ──────────────────────────────────────────────
    // Si la factura se subió en modo "clasificar" (trae candidatos), decidimos
    // su cliente real por el CIF del lado del cliente (receptor en compra,
    // emisor en venta). Si casa, reasignamos invoice.clientId y el resto del
    // pipeline opera con el cliente real (forzar parte conocida, aprendizaje,
    // dedupe). Si no casa, queda "Por clasificar" (PENDING_ROUTING) en el buzón.
    let routingReason: string | null = null;
    const isRoutingUpload = invoice.routingCandidateIds.length > 0;
    if (isRoutingUpload) {
      const candidates = await prisma.client.findMany({
        where: { id: { in: invoice.routingCandidateIds } },
        select: { id: true, cif: true, name: true, advisoryFirmId: true },
      });
      const sideCif = clientSideCif(invoice.type, {
        issuerCif: extracted.issuerCif,
        receiverCif: extracted.receiverCif,
      });
      const otherCif = invoice.type === "PURCHASE" ? extracted.issuerCif : extracted.receiverCif;
      const routing = routeByCif(
        candidates.map((c) => ({ clientId: c.id, cif: c.cif })),
        sideCif,
        otherCif,
      );

      // 1) match por CIF del cliente. 2) si no casa, regla aprendida por
      // proveedor (otra parte): si ese proveedor ya se clasificó antes a una de
      // las empresas candidatas, lo auto-ruteamos ahí.
      let resolvedClientId: string | null = null;
      if (routing.status === "routed") {
        resolvedClientId = routing.clientId;
      } else {
        routingReason = routing.reason;
        const firmId = candidates[0]?.advisoryFirmId;
        if (firmId) {
          const learned = await lookupProviderClient(firmId, otherCif);
          if (learned && candidates.some((c) => c.id === learned)) {
            resolvedClientId = learned;
          }
        }
        // 3) Fallback por texto crudo del OCR: Document AI a veces no rellena
        // el CIF estructurado aunque el CIF/nombre del cliente esté en el
        // documento. Buscamos el CIF de un candidato en el texto, y si no, su
        // nombre. Solo rutea si casa exactamente uno (intragrupo → manual).
        if (!resolvedClientId) {
          const byText = routeByText(
            ocrResult.rawText,
            candidates.map((c) => ({ clientId: c.id, cif: c.cif, name: c.name })),
          );
          if (byText) resolvedClientId = byText.clientId;
        }
      }

      if (resolvedClientId) {
        // No colar la factura en un periodo ya cerrado del cliente real: si lo
        // está, la dejamos por clasificar para que el gestor decida.
        const closure = await prisma.periodClosure.findUnique({
          where: {
            clientId_month_year: {
              clientId: resolvedClientId,
              month: invoice.periodMonth,
              year: invoice.periodYear,
            },
          },
        });
        if (closure && !closure.reopenedAt) {
          routingReason = "periodo_cerrado";
        } else {
          invoice.clientId = resolvedClientId; // reasignar al cliente real
          routingReason = null;
        }
      }
    }
    const isUnclassified = isRoutingUpload && routingReason !== null;

    // Detect issues (duplicates, low confidence, math mismatch, etc.). En las
    // "Por clasificar" no tiene sentido (aún no hay cliente real).
    const issues = isUnclassified ? [] : await detectIssues(invoiceId, extracted, invoice);
    const targetStatus: InvoiceStatus = isUnclassified
      ? "PENDING_ROUTING"
      : issues.length > 0 ? "NEEDS_ATTENTION" : "PENDING_REVIEW";

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
    // En "Por clasificar" no forzamos ninguna parte como cliente (no sabemos
    // cuál es): se guardan los datos del OCR tal cual para mostrarlos al
    // clasificar. Si está ruteada, invoice.clientId ya es el cliente real.
    const clientRecord = isUnclassified
      ? null
      : await prisma.client.findUnique({
          where: { id: invoice.clientId },
          select: { name: true, cif: true },
        });

    let finalIssuerName     = extracted.issuerName;
    let finalIssuerCif      = issuerParsed.clean || null;
    let finalIssuerCountry  = issuerParsed.countryCode;
    let finalReceiverName   = extracted.receiverName;
    let finalReceiverCif    = receiverParsed.clean || null;
    let finalReceiverCountry = receiverParsed.countryCode;

    if (clientRecord) {
      if (invoice.type === "PURCHASE") {
        finalReceiverName    = clientRecord.name;
        finalReceiverCif     = clientRecord.cif;
        // El cliente siempre es español; no tiene prefijo de país.
        finalReceiverCountry = null;
      } else {
        finalIssuerName    = clientRecord.name;
        finalIssuerCif     = clientRecord.cif;
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
    //
    // El aprendizaje por NIF (`knownEntry.defaultRetentionType`) solo lo
    // respetamos si el emisor es realmente persona fisica. Asi evitamos
    // que una factura mal validada (con retencion guardada por error)
    // de una SL/SA siga contaminando todas las siguientes — caso real
    // reportado con Parlem Telecom (B66486598) marcando retencion en
    // todas las facturas.
    const issuerIsPF = isPersonaFisica(issuerParsed.clean);
    let retentionType: RetentionTypeName | null =
      issuerIsPF ? (knownEntry?.defaultRetentionType ?? null) : null;
    let retentionRate: number | null =
      issuerIsPF && knownEntry?.defaultRetentionRate != null
        ? Number(knownEntry.defaultRetentionRate)
        : null;

    // Sugerencia automatica: persona fisica como emisor en PURCHASE.
    // Para SALE no sugerimos retencion (es el cliente quien retiene a
    // sus proveedores, no al reves).
    if (!retentionType && invoice.type === "PURCHASE" && issuerIsPF) {
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

    // ── Rectificativa / abono: solo poner el importe en NEGATIVO ───────
    //
    // Si el documento dice "rectificativa" / "nota de crédito" / "factura de
    // abono" (o ya trae importes negativos), guardamos los importes en negativo.
    // NO marcamos el flag isRectificative ni el sufijo _R del export: ese
    // comportamiento queda encapsulado al check, que el gestor activa a mano
    // si en el futuro se quiere (serie rectificada, tipo, _R, etc.).
    const hasNegativeLine = vatLines.some((l) => l.taxBase < 0 || l.vatAmount < 0);
    const hasNegativeTotal = (extracted.totalAmount ?? 0) < 0;
    const looksRectificative =
      hasNegativeLine || hasNegativeTotal || textMentionsRectificative(ocrResult.rawText);

    // Si parece abono y vino en positivo, pasamos los importes a negativo.
    // Misma regla que en revisión (lib/rectificative): si ya trae signos
    // mixtos/negativos, se respetan.
    const signed = looksRectificative
      ? applyRectificativeSign({
          lines: vatLines,
          taxBase: extracted.taxBase,
          vatAmount: extracted.vatAmount,
          totalAmount: extracted.totalAmount,
          irpfAmount: finalIrpfAmount,
          retentionBase,
        })
      : {
          lines: vatLines,
          taxBase: extracted.taxBase,
          vatAmount: extracted.vatAmount,
          totalAmount: extracted.totalAmount,
          irpfAmount: finalIrpfAmount,
          retentionBase,
        };

    // Copy OCR data to Invoice (datos finales — gestor los editará)
    await prisma.$transaction([
      // Reemplazar lineas previas (idempotente: si reproceso, borra y mete).
      prisma.invoiceVatLine.deleteMany({ where: { invoiceId } }),
      ...(signed.lines.length > 0
        ? [prisma.invoiceVatLine.createMany({
            data: signed.lines.map((l, i) => ({
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
          // Si fue ruteada, clientId ya es el real; si quedó por clasificar,
          // sigue en el buzón. routingCandidateIds se limpia al resolver y se
          // conserva mientras está por clasificar (lo usa la pantalla).
          clientId: invoice.clientId,
          routingCandidateIds: isUnclassified ? invoice.routingCandidateIds : [],
          routingReason,
          issuerName:    finalIssuerName,
          issuerCif:     finalIssuerCif,
          issuerCountry: finalIssuerCountry,
          operationType,
          receiverName:    finalReceiverName,
          receiverCif:     finalReceiverCif,
          receiverCountry: finalReceiverCountry,
          invoiceNumber: extracted.invoiceNumber,
          invoiceDate:   safeParseDate(extracted.invoiceDate),
          taxBase:       signed.taxBase,
          vatRate:       extracted.vatRate ?? denormVatRate,
          vatAmount:     signed.vatAmount,
          irpfRate:      finalIrpfRate,
          irpfAmount:    signed.irpfAmount,
          retentionType,
          retentionBase: signed.retentionBase,
          totalAmount:   signed.totalAmount,
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
    // Clasificar el error en un codigo del catalogo. Lo persistimos como
    // prefijo "[ERR-OCR-XXX] mensaje tecnico" para que la UI pueda
    // separarlos y mostrar el chip de codigo.
    const code = classifyOcrError(errorMsg);
    const taggedMsg = `[${code}] ${errorMsg}`;
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "OCR_ERROR", lastOcrError: taggedMsg },
    });
    await transitionStatus(invoiceId, "ANALYZING", "OCR_ERROR", triggeredByUserId, taggedMsg);
    console.error(`[processInvoice] ${code}:`, err);
  }
}

/** Clasifica un error de OCR en un codigo del catalogo. Heuristica simple:
 *  no necesita ser perfecta, solo ayudar al soporte a triagear sin tener
 *  que abrir logs. */
function classifyOcrError(msg: string): "ERR-OCR-001" | "ERR-OCR-002" | "ERR-OCR-003" | "ERR-OCR-004" {
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "ERR-OCR-003";
  if (lower.includes("download") || lower.includes("storage") || lower.includes("404")) return "ERR-OCR-004";
  if (lower.includes("invalid") || lower.includes("corrupt") || lower.includes("malformed")) return "ERR-OCR-002";
  return "ERR-OCR-001";
}
