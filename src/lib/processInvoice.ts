import { prisma } from "@/lib/prisma";
import { getObjectBytes, isStorageConfigured } from "@/lib/storage";
import type { InvoiceStatus, Prisma } from "@prisma/client";
import {
  extractInvoiceFromPdf,
  extractInvoiceFromImage,
  extractInvoiceFromXml,
} from "@/lib/ocr";
import {
  extractPdfWithGemini,
  extractFromDocumentWithGemini,
} from "@/lib/ocrLlm";
import { detectIssues } from "@/lib/issueDetector";
import { appendAuditLogs } from "@/lib/auditLog";
import { clientPartyAudit, irpfAuditValue, partyAuditValue } from "@/lib/auditValue";
import { clientPartyIssue } from "@/lib/clientParty";
import { ocrFenceWhere } from "@/lib/invoiceStatuses";
import { isInvoiceBalanced } from "@/lib/invoiceBalance";
import { roundCents } from "@/lib/money";
import { legalRateFor, resolveIrpf } from "@/lib/irpfResolution";

// La escritura final son unas pocas consultas; 15 s por si espera un bloqueo
// de fila (los 5 s por defecto dejaban el resultado en OCR_ERROR).
const OCR_WRITE_TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 } as const;
import {
  parseTaxId,
  taxIdWithCountry,
  isPersonaFisica,
  textMentionsRetention,
  RETENTION_DEFAULT_RATE,
  type RetentionTypeName,
} from "@/lib/validators";
import {
  foldSurchargeLines,
  completeReadSurcharges,
  proposeSurchargesFromTotal,
  surchargeAuditValue,
} from "@/lib/equivalenceSurcharge";
import { rectificativeSignHint, textMentionsRectificative, withRectificativeMention } from "@/lib/rectificative";
import { routeByCif, clientSideCif, routeByText, detectInvoiceType } from "@/lib/invoiceRouting";
import { lookupProviderClient, normalizeProviderNif } from "@/lib/providerRouting";
import { accountEntryKey } from "@/lib/supplierMatching";
import { proposeOperationType, unclassifiedGoodsType } from "@/lib/operationTypeProposal";
import { classifyOcrError, DocumentError, userMessageForError } from "@/lib/ocrErrors";
import { closeOpenIssues } from "@/lib/invoiceIssues";

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
  // Claim atomico: solo arranca si sigue en UPLOADED. El fencing token de
  // esta ejecucion es el ocrAttempts que deja el propio UPDATE; leido despues
  // con otra consulta podria ser ya el de un claim posterior.
  const [claimed] = await prisma.invoice.updateManyAndReturn({
    where: { id: invoiceId, status: "UPLOADED" },
    data: { status: "ANALYZING", ocrAttempts: { increment: 1 } },
    select: { ocrAttempts: true },
  });
  if (!claimed) return;
  const ocrToken = claimed.ocrAttempts;

  await transitionStatus(invoiceId, "UPLOADED", "ANALYZING", triggeredByUserId);

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  const ocrStartedAt = new Date();

  try {
    if (!isStorageConfigured()) throw new Error("Almacenamiento (S3) no configurado");

    let source: string;
    let ocrResult;
    const ft = invoice.fileType;

    // Reintento ante fallos TRANSITORIOS del OCR (timeout, rate limit, red): el
    // proveedor (Gemini/Document AI) falla a veces de forma puntual y al
    // reprocesar va — lo automatizamos para no dejar la factura en Error OCR
    // por un hipo. Los fallos deterministas (archivo inválido) no se reintentan.
    const MAX_OCR_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        if (ft.includes("xml")) {
          source = "xml_parse";
          const xmlText = (await getObjectBytes(invoice.storageKey)).toString("utf-8");
          ocrResult = await extractInvoiceFromXml(xmlText);
        } else {
          const base64 = (await getObjectBytes(invoice.storageKey)).toString("base64");

          if (ft === "application/pdf" || invoice.filename.endsWith(".pdf")) {
            if (process.env.GEMINI_API_KEY) {
              // Solo lanza si falla la llamada que no tiene alternativa: la
              // del texto, o la de la imagen cuando el texto no valia. Si el
              // texto ya salio (aunque incompleto) y la imagen falla, devuelve
              // el del texto: el reintento no repite una llamada que ya fue
              // bien (temperatura 0, saldria lo mismo).
              ({ source, result: ocrResult } = await extractPdfWithGemini(base64));
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
        break; // OCR completado
      } catch (ocrErr) {
        // Un error del documento no es transitorio aunque su texto lo parezca:
        // «El XML trae 500 facturas (lote)» casaba con el 500 de la regex.
        if (ocrErr instanceof DocumentError) throw ocrErr;
        const m = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
        if (attempt >= MAX_OCR_ATTEMPTS || !isTransientOcrError(m)) throw ocrErr;
        // Backoff corto antes de reintentar (1.2s, 2.4s).
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }

    const extracted = ocrResult.extracted;
    // A centimos antes de nada: la BD guarda numeric(12,2), y el cuadre
    // (isValid, incidencias) se calculaba con los importes sin redondear que
    // luego no son los guardados (revision 2 del PR #7). Los % tambien van a
    // 2 decimales (numeric(5,2)).
    extracted.taxBase = roundCents(extracted.taxBase);
    extracted.vatAmount = roundCents(extracted.vatAmount);
    extracted.totalAmount = roundCents(extracted.totalAmount);
    // La retencion siempre en positivo: una factura que imprime «IRPF −15 %»
    // guardaba −15 y la pantalla ya no dejaba ni guardar el borrador. El OCR
    // no pone el signo de una rectificativa (F-012): lo pone la revision al
    // marcar la casilla.
    const positive = (v: number | null) => (v == null ? v : Math.abs(v));
    // Lo que cambia el sistema sin que lo toque el gestor queda en la
    // auditoria como auto:* (F-024). Primero, el signo de la retencion.
    const autoAudit: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    const printedIrpf = irpfAuditValue(roundCents(extracted.irpfRate), roundCents(extracted.irpfAmount));
    extracted.irpfAmount = roundCents(positive(extracted.irpfAmount));
    // Los % tambien: con 7,005 % la cuota se calculaba con el % sin redondear
    // y la BD guardaba 7,01, asi que la revision la daba por descuadrada.
    extracted.vatRate = roundCents(extracted.vatRate);
    extracted.irpfRate = roundCents(positive(extracted.irpfRate));
    const readIrpf = irpfAuditValue(extracted.irpfRate, extracted.irpfAmount);
    if (printedIrpf !== readIrpf) autoAudit.push({ field: "auto:signo", oldValue: printedIrpf, newValue: readIrpf });
    extracted.vatLines = extracted.vatLines.map((l) => ({
      ...l,
      taxBase: roundCents(l.taxBase),
      vatRate: roundCents(l.vatRate),
      vatAmount: roundCents(l.vatAmount),
      equivalenceSurchargeRate: roundCents(l.equivalenceSurchargeRate),
      equivalenceSurchargeAmount: roundCents(l.equivalenceSurchargeAmount),
    }));
    // El recargo de equivalencia llega a veces como una linea de IVA mas, con
    // el tipo del recargo (5,2 / 1,4 / 0,5) y el importe en la cuota o en la
    // base, porque en la factura aparece como otra fila del cuadro de
    // impuestos ("REC 5,2% ... 14,90"). Se pliega sobre su linea de IVA antes
    // de tocar nada mas, y si solo vino la mitad (% sin cuota o al reves) se
    // completa. Ver src/lib/equivalenceSurcharge.ts.
    extracted.vatLines = completeReadSurcharges(foldSurchargeLines(extracted.vatLines).lines);
    // rawResponse ahora es la respuesta CRUDA del proveedor (entities +
    // text para Doc AI; XML literal para Facturae). Antes guardabamos el
    // resultado ya mapeado, lo cual no servia para debugging.
    const rawResponse = ocrResult.rawJson;

    // Math validation: Σ(bases) + Σ(cuotas) - IRPF = Total. Leave isValid=null
    // if total/lines incompletos asi el revisor se ve forzado a rellenar.
    const { taxBase, vatAmount, totalAmount, irpfAmount, vatLines } = extracted;
    let isValid: boolean | null = null;
    if (taxBase !== null && vatAmount !== null && totalAmount !== null) {
      isValid = isInvoiceBalanced({ sumBase: taxBase, sumAmount: vatAmount, irpf: irpfAmount ?? 0, total: totalAmount });
    }

    // Save extraction as separate record (datos brutos OCR + job tracking)
    const ocrFinishedAt = new Date();
    const ocrDurationMs = ocrFinishedAt.getTime() - ocrStartedAt.getTime();
    const isReprocess = ocrToken > 1;

    // Se guarda dentro de la transaccion vallada, mas abajo: si esta
    // ejecucion ya no es la duena, sus cajas y su confianza no pueden salir
    // en la revision junto a los datos de la ejecucion buena.
    const extractionData = {
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
    } satisfies Prisma.InvoiceExtractionUncheckedCreateInput;

    // ── Auto-ruteo multicliente ──────────────────────────────────────────────
    // Si la factura se subió en modo "clasificar" (trae candidatos), decidimos
    // su cliente real por el CIF del lado del cliente (receptor en compra,
    // emisor en venta). Si casa, reasignamos invoice.clientId y el resto del
    // pipeline opera con el cliente real (forzar parte conocida, aprendizaje,
    // dedupe). Si no casa, queda "Por clasificar" (PENDING_ROUTING) en el buzón.
    let routingReason: string | null = null;
    let routedByRule: { field: string; oldValue: string | null; newValue: string | null } | null = null;
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

      let resolvedClientId: string | null = null;
      const byCifCandidates = candidates.map((c) => ({ clientId: c.id, cif: c.cif }));
      const other = normalizeProviderNif(otherCif);
      const otherIsCandidate = !!other && candidates.some((c) => normalizeProviderNif(c.cif) === other);
      // Texto y regla, cuando el CIF del lado del cliente no decide.
      const byTextAndRule = async (textCandidates: typeof candidates, ruleAllowed: boolean) => {
        // Document AI a veces no rellena el CIF estructurado aunque el CIF
        // o el nombre del cliente esten en el documento. Solo rutea si casa
        // exactamente uno; con varios (intragrupo), al buzon y sin la regla.
        const byText = routeByText(
          ocrResult.rawText,
          textCandidates.map((c) => ({ clientId: c.id, cif: c.cif, name: c.name })),
        );
        if (byText && "clientId" in byText) return byText.clientId;
        const firmId = candidates[0]?.advisoryFirmId;
        if (!ruleAllowed || !firmId || (byText != null && "ambiguous" in byText)) return null;
        const learned = await lookupProviderClient(firmId, otherCif);
        if (!learned || !candidates.some((c) => c.id === learned)) return null;
        const chosen = candidates.find((c) => c.id === learned)!;
        const providerParsed = parseTaxId(otherCif);
        routedByRule = {
          field: "auto:ruteo",
          oldValue: null,
          // «·» como las demas auto:*: las pantallas ya pintan «viejo → nuevo».
          // La otra parte: el proveedor en una compra, el cliente en una venta.
          newValue: `${partyAuditValue(chosen.name, chosen.cif)} · ${invoice.type === "SALE" ? "cliente" : "proveedor"} ${taxIdWithCountry(providerParsed.clean, providerParsed.countryCode)}`,
        };
        return learned;
      };
      const sideUnreadable = routing.status === "unclassified" && (routing.reason === "no_cif" || routing.reason === "invalid_cif");
      if (routing.status === "routed") {
        resolvedClientId = routing.clientId;
      } else if (invoice.typeUnconfirmed && routing.reason !== "ambiguous") {
        routingReason = routing.reason;
        // «Detectar automaticamente»: el tipo guardado (compra) es solo un
        // marcador, y que el receptor no enrute no quiere decir nada. Primero
        // el emisor: si casa, es una venta del cliente (detectInvoiceType la
        // fija mas abajo). Despues el texto, con todos los candidatos. La
        // regla del proveedor solo si el emisor no es del grupo: si lo es, es
        // una venta suya, no una compra a un proveedor.
        const swapped = routeByCif(byCifCandidates, otherCif, sideCif);
        if (swapped.status === "routed") {
          // Con el receptor ilegible, puede ser una factura de A a otra
          // empresa del grupo cuyo CIF no se relleno: si el texto trae el CIF
          // de otra candidata, al buzon. Si no, B perdia la compra y quedaba
          // como venta de A confirmada. Con el CIF de B legible ya va al
          // buzon por ambiguous.
          const toOther = sideUnreadable
            ? routeByText(
                ocrResult.rawText,
                candidates.filter((c) => c.id !== swapped.clientId).map((c) => ({ clientId: c.id, cif: c.cif, name: c.name })),
                { cifOnly: true },
              )
            : null;
          if (toOther) routingReason = "ambiguous";
          else resolvedClientId = swapped.clientId;
        } else {
          resolvedClientId = await byTextAndRule(candidates, sideUnreadable && !otherIsCandidate);
        }
      } else {
        routingReason = routing.reason;
        // 1) Match por CIF del cliente. Si no hay CIF legible en su lado (no
        // se leyo, o no pasa el digito de control), 2) el texto crudo del OCR
        // y 3) la regla aprendida por proveedor (otra parte). Con un CIF
        // valido que no casa (o casa con varias) no se adivina: probablemente
        // es de otro (F-019) y va a «Por clasificar» (F-021).
        // Con el tipo confirmado, el CIF de la otra parte siempre esta en el
        // texto: si es una empresa del grupo (factura de A a B), el texto la
        // encontraria a ella y la factura acabaria en A como compra de A a si
        // misma. Esa no es candidata.
        if (sideUnreadable) {
          const textCandidates = other ? candidates.filter((c) => normalizeProviderNif(c.cif) !== other) : candidates;
          resolvedClientId = await byTextAndRule(textCandidates, true);
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
          // Enrutada por la regla del proveedor: que quede el rastro.
          if (routedByRule) autoAudit.push(routedByRule);
        }
      }
    }
    const isUnclassified = isRoutingUpload && routingReason !== null;
    // En el buzon no se crean incidencias y al clasificar ya no hay texto: la
    // mencion de rectificativa se guarda para que classifyInvoice la lea.
    // (Un Facturae rectificativo lo lee classifyInvoice del propio XML.)
    if (isUnclassified && textMentionsRectificative(ocrResult.rawText)) {
      extractionData.rawResponse = withRectificativeMention(extractionData.rawResponse);
    }

    // Normalizacion de NIFs y deteccion de tipo de operacion a partir del
    // prefijo del NIF (parser en validators.ts para no tocar OCR).
    const issuerParsed   = parseTaxId(extracted.issuerCif);
    const receiverParsed = parseTaxId(extracted.receiverCif);

    // El cliente hace falta ya aqui: su marca de Recargo de Equivalencia
    // decide si se propone el recargo, y eso tiene que estar hecho ANTES de
    // detectar incidencias.
    const clientRecord = isUnclassified
      ? null
      : await prisma.client.findUnique({
          where: { id: invoice.clientId },
          select: { name: true, cif: true, equivalenceSurchargeCustomer: true },
        });

    // Recargo de equivalencia propuesto desde el total. Va antes de
    // detectIssues a proposito: si no, el detector ve la factura descuadrada
    // justo por el importe del recargo y persiste un "Error matematico" que
    // contradice a los datos que se guardan unas lineas mas abajo, ademas de
    // mandar la factura a "Requiere atencion". Con Document AI el recargo no
    // se lee NUNCA, asi que le pasaba a todas las facturas de un cliente en RE.
    const readSurcharge = surchargeAuditValue(extracted.vatLines);
    if (clientRecord?.equivalenceSurchargeCustomer) {
      for (const p of proposeSurchargesFromTotal(extracted.vatLines, extracted.totalAmount, extracted.irpfAmount)) {
        extracted.vatLines[p.index].equivalenceSurchargeRate = p.rate;
        extracted.vatLines[p.index].equivalenceSurchargeAmount = p.amount;
      }
    }

    // vatRate denormalizado: solo significativo cuando hay una unica linea.
    // Multi-IVA -> null (el desglose vive en InvoiceVatLine).
    const denormVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;

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
    // (clientRecord se lee mas arriba: hace falta antes de detectar
    // incidencias para saber si el cliente va en Recargo de Equivalencia.)

    // ── Detección del tipo cuando se subió como "No lo sé" ─────────────
    // El lado donde aparece el CIF del cliente decide: receptor -> compra,
    // emisor -> venta. Si casa con claridad, fijamos el tipo y limpiamos el
    // flag; si no, queda provisional y el gestor lo confirma en la revisión.
    // Tiene que ir ANTES de la lógica que usa invoice.type (parte conocida,
    // operationType, retención).
    let typeUnconfirmed = invoice.typeUnconfirmed;
    if (typeUnconfirmed && clientRecord) {
      const detected = detectInvoiceType(clientRecord.cif, {
        issuerCif: extracted.issuerCif,
        receiverCif: extracted.receiverCif,
      });
      if (detected) {
        invoice.type = detected;
        typeUnconfirmed = false;
      }
    }

    let finalIssuerName      = extracted.issuerName;
    let finalIssuerCif       = issuerParsed.clean || null;
    let finalIssuerCountry   = issuerParsed.countryCode;
    let finalReceiverName    = extracted.receiverName;
    let finalReceiverCif     = receiverParsed.clean || null;
    let finalReceiverCountry = receiverParsed.countryCode;

    if (clientRecord) {
      // Si el OCR leyo en el lado del cliente otra cosa, se sustituye y queda
      // en la auditoria. Si no leyo nada, rellenarlo no es un cambio.
      const substituted = clientPartyAudit(
        invoice.type === "PURCHASE"
          ? { name: extracted.receiverName, cif: receiverParsed.clean }
          : { name: extracted.issuerName, cif: issuerParsed.clean },
        clientRecord,
      );
      if (substituted) autoAudit.push({ field: "auto:parteCliente", ...substituted });
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
    const otherPartyName = invoice.type === "PURCHASE" ? extracted.issuerName : extracted.receiverName;

    // Aprendizaje por tercero: si ya hemos visto a esta otra parte en este
    // cliente y el gestor le asigno un operationType / retencion, lo
    // respetamos. Asi proveedores recurrentes (gestoria, abogado,
    // alquiler) se autoconfiguran desde la 2a factura.
    //
    // La clave es accountEntryKey (NIF si es fiable, nombre normalizado si
    // no) para que proveedores extranjeros sin NIF/VAT fiable (ej. chinos)
    // tambien puedan encontrar/aprender su fila sin arriesgar fusionarse con
    // otro tercero que comparta el mismo identificador basura.
    const entryKey = accountEntryKey(otherPartyClean, otherPartyName, otherParty.countryCode);
    const foundEntry = entryKey
      ? await prisma.accountEntry.findUnique({
          where: { clientId_nif: { clientId: invoice.clientId, nif: entryKey } },
          select: {
            nif: true,
            name: true,
            defaultOperationType: true,
            defaultRetentionType: true,
            defaultRetentionRate: true,
            intracomGoodsTypePurchase: true,
            intracomGoodsTypeSale: true,
          },
        }).catch(() => null)
      : null;
    // Lo aprendido (tipo de operacion, retencion) se aplica por NIF aunque el
    // nombre no coincida; la revision avisa del nombre distinto. El tipo de
    // operacion y bienes/servicios, con la misma funcion que al clasificar.
    const knownEntry = foundEntry;
    const intracomProposal = proposeOperationType({
      direction: invoice.type,
      prefixOperationType: otherParty.operationType,
      otherPartyName,
      entry: knownEntry,
      ai: extracted.supplyType,
    });
    const operationType = intracomProposal.operationType;
    const goods = isUnclassified ? unclassifiedGoodsType(intracomProposal, extracted.supplyType) : intracomProposal;

    // ── Deteccion de retencion IRPF ────────────────────────────────────
    //
    // Heuristica conservadora: solo sugerimos retencion si el emisor
    // (en PURCHASE) es persona fisica (DNI/NIE) Y el OCR vio de verdad
    // una retencion en el documento. El gestor la ajusta o desactiva.
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

    // Sugerencia automatica: persona fisica como emisor en PURCHASE y,
    // ademas, el OCR tiene que haber VISTO una retencion en el documento.
    // Ser autonomo no implica retener (comercio, hosteleria, modulos...):
    // antes se inventaba un 15% en facturas sin IRPF y se machacaba el
    // porcentaje real extraido (7%, 2%, 1%...) con el default.
    // Para SALE no sugerimos retencion (es el cliente quien retiene a
    // sus proveedores, no al reves).
    //
    // "Vio retencion" tiene que ser > 0, no "!= null": Facturae obliga a
    // incluir TotalTaxesWithheld y una factura SIN retencion trae un 0.00
    // literal, que con `!= null` volvia a disparar el 15% inventado.
    //
    // Y hay que mirar tambien el texto: Document AI no extrae IRPF nunca
    // (devuelve null fijo), asi que solo con los campos numericos la
    // sugerencia moriria por completo en ese modo de despliegue.
    const ocrSawIrpf =
      (extracted.irpfRate ?? 0) > 0 ||
      (extracted.irpfAmount ?? 0) !== 0 ||
      textMentionsRetention(ocrResult.rawText);
    if (!retentionType && invoice.type === "PURCHASE" && issuerIsPF && ocrSawIrpf) {
      retentionType = "PROFESSIONAL";
      // Si el OCR dio el importe pero no el %, lo deducimos de las bases en
      // vez de asumir el 15%: al recalcular la cuota mas abajo, un default
      // equivocado sobrescribiria el importe real extraido del documento.
      // Solo un tipo legal: base / importe a secas daba 12,5 % con una linea
      // al 0 %, o 6,99 % con una base pequeña.
      const baseParaTipo = vatLines.reduce((acc, l) => acc + l.taxBase, 0);
      const tipoDeducido = extracted.irpfAmount != null
        ? legalRateFor(baseParaTipo, (baseParaTipo < 0 ? -1 : 1) * Math.abs(extracted.irpfAmount))
        : null;
      retentionRate =
        extracted.irpfRate ?? tipoDeducido ?? RETENTION_DEFAULT_RATE.PROFESSIONAL;
    }

    // Calculamos cuota e importe de la base de retencion solo si hay
    // tipo. La base por defecto es la suma de bases imponibles del IVA.
    const sumBasesAll = vatLines.reduce((s, l) => s + l.taxBase, 0);
    const retentionBase = retentionType ? sumBasesAll : null;
    // Si la factura cuadra con el importe leido, se queda ese (F-073); si
    // no, base × % con el mismo redondeo que la pantalla (percentOf): con
    // toFixed, 100,30 al 15 % daba 15,04 frente a los 15,05 impresos y la
    // factura quedaba isValid=false sin ninguna incidencia.
    const sumVat = vatLines.reduce((s, l) => s + l.vatAmount, 0);
    const sumSurcharge = vatLines.reduce((s, l) => s + (l.equivalenceSurchargeAmount ?? 0), 0);
    const { rate: finalIrpfRate, amount: finalIrpfAmount } = resolveIrpf({
      hasRetention: retentionType != null,
      retentionRate,
      readRate: extracted.irpfRate ?? null,
      readAmount: extracted.irpfAmount ?? null,
      sumBases: sumBasesAll,
      balancedWith: (irpf) => extracted.totalAmount != null
        && isInvoiceBalanced({ sumBase: sumBasesAll, sumAmount: sumVat, sumSurcharge, irpf, total: extracted.totalAmount }),
    });
    // Solo cuando de verdad se sustituye lo leido: retencion propuesta
    // (tercero aprendido, persona fisica) o recalculada.
    const finalIrpf = irpfAuditValue(finalIrpfRate, finalIrpfAmount);
    if (finalIrpf === printedIrpf) {
      // Se guarda exactamente lo impreso (un abono con el IRPF en negativo:
      // auto:signo lo paso a positivo y resolveIrpf le devuelve el signo de
      // la base): ni auto:signo ni auto:irpf, que se anulaban.
      const signo = autoAudit.findIndex((e) => e.field === "auto:signo");
      if (signo >= 0) autoAudit.splice(signo, 1);
    } else if (finalIrpf !== readIrpf) {
      autoAudit.push({ field: "auto:irpf", oldValue: readIrpf, newValue: finalIrpf });
    }

    // Detect issues (duplicates, low confidence, math mismatch, IVA no-cero
    // en intracomunitarias, etc.). En las "Por clasificar" no tiene sentido
    // (aún no hay cliente real). Va despues de decidir el tipo de operacion
    // final (el aprendido del tercero incluido): con la pista del prefijo del
    // NIF, una inversion del sujeto pasivo con cuota 0 salia como desglose
    // descuadrado (revision 1 del PR #7). Y despues de la retencion: el
    // cuadre tiene que hacerse con el IRPF que se va a guardar (recalculado
    // con el % redondeado), no con el leido; si no, quedaba isValid=false
    // sin ninguna incidencia (revision 1 del PR #8).
    const issues = isUnclassified
      ? []
      : await detectIssues(invoiceId, { ...extracted, irpfAmount: finalIrpfAmount }, invoice, operationType, { persist: false });
    // Rectificativa: incidencia en vez de cambiar signos (F-012).
    if (!isUnclassified) {
      const hint = rectificativeSignHint({
        lines: vatLines, taxBase: extracted.taxBase, vatAmount: extracted.vatAmount,
        totalAmount: extracted.totalAmount, irpfAmount: finalIrpfAmount, retentionBase,
      }, ocrResult.rawText, extracted.isCorrective === true);
      if (hint) issues.push({ type: "MANUAL", description: hint, field: "isRectificative" });
    }
    // A nombre de otro (F-019): en el lado del cliente se leyo un CIF valido
    // que no es el suyo. Los datos se sustituyen igual, pero se avisa. Con el
    // tipo sin confirmar, el lado del cliente es una suposicion: el «Por
    // confirmar» ya obliga a revisarlo, y el aviso de la pantalla se
    // recalcula al elegir el tipo.
    if (!isUnclassified && clientRecord && !typeUnconfirmed) {
      const foreign = clientPartyIssue(invoice.type, extracted, clientRecord);
      if (foreign) issues.push(foreign);
    }
    const targetStatus: InvoiceStatus = isUnclassified
      ? "PENDING_ROUTING"
      : issues.length > 0 ? "NEEDS_ATTENTION" : "PENDING_REVIEW";

    // ── Rectificativa / abono: el OCR NO cambia signos (F-012) ─────────
    //
    // Antes, si el texto decia "rectificativa" / "nota de crédito" /
    // "factura de abono" se negaban todos los importes sin marcar
    // isRectificative: daba positivo con «no es rectificativa» y una compra
    // ordinaria pasaba a IVA soportado negativo. Ahora se guardan como se
    // leyeron y la incidencia de arriba (rectificativeSignHint) avisa. Estos
    // son los importes que se guardan (con la retencion ya recalculada).
    const amounts = {
      lines: vatLines,
      taxBase: extracted.taxBase,
      vatAmount: extracted.vatAmount,
      totalAmount: extracted.totalAmount,
      irpfAmount: finalIrpfAmount,
      retentionBase,
    };

    // ── Recargo de equivalencia ─────────────────────────────────────────
    //
    // Va POR LINEA de IVA, no por factura: cada tipo (21/10/4) puede llevar
    // su propio recargo, y una linea concreta (p.ej. portes) puede no
    // llevarlo aunque el resto de la factura si. Se aplica tanto en COMPRAS
    // como en VENTAS de clientes minoristas acogidos a RE — no se limita a
    // un sentido. Nunca lo inventamos por el simple hecho de que el IVA sea
    // 21/10/4 — exige que el cliente este marcado explicitamente
    // (Client.equivalenceSurchargeCustomer).
    //
    // Por cada linea:
    // 1) Lo que el OCR/IA leyo en el documento para ESA linea manda, con el
    //    signo impreso (el OCR no lo cambia).
    // 2) Si el cliente esta en RE y la factura no llega a su total por si
    //    sola, se propone el recargo SOLO en las lineas cuya suma explique esa
    //    diferencia, ajustando el ultimo centimo. Asi no se le cuelga recargo
    //    a los portes ni nos desviamos del importe impreso, que es lo que
    //    pasaba al aplicar el mapeo a ciegas linea por linea.
    const lineSurcharges: { rate: number | null; amount: number | null }[] = amounts.lines.map((l) => ({
      rate: l.equivalenceSurchargeRate ?? null,
      amount: l.equivalenceSurchargeAmount ?? null,
    }));
    // Segunda pasada con la retencion final. Normalmente no hace nada (la
    // propuesta de antes de detectIssues ya dejo el recargo puesto): solo
    // entra cuando la retencion recalculada cambia lo que falta para el total.
    if (clientRecord?.equivalenceSurchargeCustomer) {
      for (const p of proposeSurchargesFromTotal(amounts.lines, amounts.totalAmount, amounts.irpfAmount)) {
        lineSurcharges[p.index] = { rate: p.rate, amount: p.amount };
      }
    }
    const totalSurchargeAmount = lineSurcharges.reduce((s, ls) => s + (ls.amount ?? 0), 0);
    const finalSurcharge = surchargeAuditValue(amounts.lines.map((l, i) => ({
      ...l, equivalenceSurchargeRate: lineSurcharges[i].rate, equivalenceSurchargeAmount: lineSurcharges[i].amount,
    })));
    if (finalSurcharge !== readSurcharge) autoAudit.push({ field: "auto:recargo", oldValue: readSurcharge, newValue: finalSurcharge });

    // isValid final: Σ(bases) + Σ(cuotas) + Σ(recargo) - IRPF = Total, con
    // los importes que se guardan (el `isValid` de mas arriba es un
    // diagnostico de la extraccion cruda, antes de la retencion recalculada y
    // del recargo).
    let finalIsValid: boolean | null = null;
    if (amounts.lines.length > 0 && amounts.totalAmount !== null) {
      const sBase = amounts.lines.reduce((s, l) => s + l.taxBase, 0);
      const sAmount = amounts.lines.reduce((s, l) => s + l.vatAmount, 0);
      finalIsValid = isInvoiceBalanced({
        sumBase: sBase, sumAmount: sAmount, sumSurcharge: totalSurchargeAmount,
        irpf: amounts.irpfAmount ?? 0, total: amounts.totalAmount,
      });
    } else {
      finalIsValid = isValid;
    }

    // Copy OCR data to Invoice (datos finales — gestor los editará)
    //
    // Todo en una transaccion que empieza por la escritura condicionada a que
    // la factura siga en ANALYZING con el ocrAttempts de este claim (F-008).
    // Si mientras analizaba la rechazaron, dividieron o validaron, o el cron
    // la relanzo, no se toca nada: ni lineas, ni incidencias, ni historial,
    // ni auditoria.
    const written = await prisma.$transaction(async (tx) => {
      const fenced = await tx.invoice.updateMany({
        where: ocrFenceWhere(invoiceId, ocrToken),
        data: {
          status: targetStatus,
          // Tipo detectado (si se subió como "No lo sé" y el OCR lo resolvió);
          // si no se pudo, queda el placeholder con typeUnconfirmed=true.
          type: invoice.type,
          typeUnconfirmed,
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
          intracomGoodsType:   goods.goodsType,
          intracomGoodsSource: goods.source,
          receiverName:    finalReceiverName,
          receiverCif:     finalReceiverCif,
          receiverCountry: finalReceiverCountry,
          invoiceNumber: extracted.invoiceNumber,
          invoiceDate:   safeParseDate(extracted.invoiceDate),
          taxBase:       amounts.taxBase,
          vatRate:       extracted.vatRate ?? denormVatRate,
          vatAmount:     amounts.vatAmount,
          irpfRate:      finalIrpfRate,
          irpfAmount:    amounts.irpfAmount,
          retentionType,
          retentionBase: amounts.retentionBase,
          totalAmount:   amounts.totalAmount,
          // Si este OCR no ve la moneda se conserva la que ya tenia (p.ej. la
          // heredada de la factura madre al dividir un PDF en USD).
          currency:      extracted.currency ?? invoice.currency,
          // isValid final: recalculado con los importes que se guardan (la
          // retencion final) y el recargo de equivalencia por linea (el
          // `isValid` de mas arriba es un diagnostico de la extraccion cruda
          // — se guarda tal cual en InvoiceExtraction, no aqui).
          isValid: finalIsValid,
          lastOcrError:  null,
        },
      });
      if (fenced.count === 0) return false;

      await tx.invoiceExtraction.create({ data: extractionData });

      // Reemplazar lineas previas (idempotente: si reproceso, borra y mete).
      await tx.invoiceVatLine.deleteMany({ where: { invoiceId } });
      if (amounts.lines.length > 0) {
        await tx.invoiceVatLine.createMany({
          data: amounts.lines.map((l, i) => ({
            invoiceId,
            position:  i,
            taxBase:   l.taxBase,
            vatRate:   l.vatRate,
            vatAmount: l.vatAmount,
            equivalenceSurchargeRate:   lineSurcharges[i].rate,
            equivalenceSurchargeAmount: lineSurcharges[i].amount,
          })),
        });
      }
      // Reprocesar (F-057): las incidencias de la lectura anterior se cierran;
      // las que sigan aplicando se crean otra vez aqui.
      await closeOpenIssues(tx, invoiceId, triggeredByUserId);
      if (issues.length > 0) {
        await tx.invoiceIssue.createMany({
          data: issues.map((issue) => ({
            invoiceId,
            type: issue.type,
            description: issue.description,
            field: issue.field ?? null,
          })),
        });
      }
      await tx.invoiceStatusHistory.create({
        data: { invoiceId, fromStatus: "ANALYZING", toStatus: targetStatus, changedBy: triggeredByUserId },
      });
      await appendAuditLogs([{
        invoiceId,
        userId: triggeredByUserId,
        field: "status",
        oldValue: "UPLOADED",
        newValue: targetStatus,
      }, ...autoAudit.map((e) => ({ invoiceId, userId: triggeredByUserId, ...e }))], tx);
      return true;
    }, OCR_WRITE_TRANSACTION_OPTIONS);
    if (!written) {
      console.warn(`[processInvoice] ${invoiceId}: la factura cambio mientras se analizaba (ocrAttempts=${ocrToken}); no se escribe el resultado`);
    }
  } catch (err) {
    // Clasificar el error en un codigo del catalogo. Lo persistimos como
    // prefijo "[ERR-OCR-XXX] mensaje tecnico" para que la UI pueda
    // separarlos y mostrar el chip de codigo.
    const code = classifyOcrError(err);
    // Mensaje LIMPIO para el gestor (nada de stacks de Prisma en la UI). El
    // detalle técnico completo se queda en el log para depuración.
    const userMsg = `[${code}] ${userMessageForError(err, code)}`;
    console.error(`[processInvoice] ${code}:`, err);
    // Mismo fencing que el final: un error de una ejecucion que ya no es la
    // duena no puede pasar a OCR_ERROR una factura rechazada o validada.
    try {
      await prisma.$transaction(async (tx) => {
        const fenced = await tx.invoice.updateMany({
          where: ocrFenceWhere(invoiceId, ocrToken),
          data: { status: "OCR_ERROR", lastOcrError: userMsg },
        });
        if (fenced.count === 0) return;
        await tx.invoiceStatusHistory.create({
          data: { invoiceId, fromStatus: "ANALYZING", toStatus: "OCR_ERROR", changedBy: triggeredByUserId, reason: userMsg },
        });
      });
    } catch (writeErr) {
      console.error(`[processInvoice] ${invoiceId}: no se pudo guardar el OCR_ERROR:`, writeErr);
    }
  }
}

/** ¿El fallo de OCR es transitorio (merece reintento) o determinista? Los
 *  deterministas (archivo inválido/corrupto) no se reintentan: fallarían igual.
 *  Solo reintentamos patrones claramente transitorios (timeout, rate limit,
 *  red, 5xx) para no malgastar llamadas en errores que no se van a recuperar. */
function isTransientOcrError(msg: string): boolean {
  const m = msg.toLowerCase();
  if (m.includes("invalid") || m.includes("corrupt") || m.includes("malformed")) return false;
  return /timeout|timed out|rate limit|too many requests|429|econnreset|etimedout|enotfound|fetch failed|network|socket hang up|503|502|500|unavailable|overloaded/.test(m);
}

