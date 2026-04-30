import { GoogleAuth } from "google-auth-library";
import { XMLParser } from "fast-xml-parser";

/** Una linea del desglose de IVA. Una factura con varios tipos
 *  (4% + 10% + 21%) tiene varias lineas. Cuando la factura tiene un
 *  unico tipo, vatLines tiene una sola entrada. */
export type ExtractedVatLine = {
  taxBase:   number;
  vatRate:   number;
  vatAmount: number;
};

export type ExtractedInvoice = {
  issuerName:    string | null;
  issuerCif:     string | null;
  receiverName:  string | null;
  receiverCif:   string | null;
  invoiceNumber: string | null;
  invoiceDate:   string | null; // YYYY-MM-DD
  /** Suma de bases de todas las lineas de IVA. */
  taxBase:       number | null;
  /** % de IVA cuando hay una sola linea; null si hay varias. */
  vatRate:       number | null;
  /** Suma de cuotas de todas las lineas de IVA. */
  vatAmount:     number | null;
  irpfRate:      number | null;
  irpfAmount:    number | null;
  totalAmount:   number | null;
  /** Desglose de IVA. Vacio si no se pudo extraer. */
  vatLines:      ExtractedVatLine[];
  confidence:    Record<string, number> | null;
};

/** Cached GoogleAuth instance to avoid re-parsing credentials on every call */
let _authClient: GoogleAuth | null = null;

function getAuthClient(): GoogleAuth {
  if (_authClient) return _authClient;
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credJson) throw new Error("Falta la variable GOOGLE_APPLICATION_CREDENTIALS_JSON");

  _authClient = new GoogleAuth({
    credentials: JSON.parse(credJson),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return _authClient;
}

/** Obtiene un access token de Google usando las credenciales de la variable de entorno */
async function getAccessToken(): Promise<string> {
  const auth = getAuthClient();
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Google Auth no devolvió un token de acceso");
  return token;
}

/**
 * Extrae el valor monetario de una entidad de Document AI.
 * Document AI devuelve el dinero como { units: "1210", nanos: 500000000 }
 * lo que equivale a 1210.50 €
 */
function getMoney(entity: any): number | null {
  if (!entity) return null;

  const mv = entity.normalizedValue?.moneyValue;
  if (mv !== undefined) {
    const units = parseInt(mv.units ?? "0", 10);
    const nanos = mv.nanos ?? 0;
    return parseFloat((units + nanos / 1e9).toFixed(2));
  }

  // Fallback: intentar parsear el texto directamente
  const raw = entity.mentionText?.replace(/[€$£\s]/g, "").replace(",", ".") ?? "";
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Extrae una fecha de una entidad de Document AI.
 * Devuelve formato YYYY-MM-DD.
 */
function getDate(entity: any): string | null {
  if (!entity) return null;

  const dv = entity.normalizedValue?.dateValue;
  if (dv) {
    const y = dv.year;
    const m = String(dv.month).padStart(2, "0");
    const d = String(dv.day).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  return entity.mentionText?.trim() ?? null;
}

/** All extraction field names for confidence mapping */
const ALL_FIELDS = [
  "issuerName", "issuerCif", "receiverName", "receiverCif",
  "invoiceNumber", "invoiceDate", "taxBase", "vatRate",
  "vatAmount", "irpfRate", "irpfAmount", "totalAmount",
];

/** Maps Document AI entity type to our field name */
const ENTITY_TO_FIELD: Record<string, string> = {
  supplier_name: "issuerName",
  supplier_tax_id: "issuerCif",
  receiver_name: "receiverName",
  receiver_tax_id: "receiverCif",
  invoice_id: "invoiceNumber",
  invoice_date: "invoiceDate",
  net_amount: "taxBase",
  vat_tax_rate: "vatRate",
  vat: "vatRate",
  vat_tax_amount: "vatAmount",
  total_tax_amount: "vatAmount",
  total_amount: "totalAmount",
};

/** Parsea un porcentaje desde el mentionText (ej. "21%" -> 21, "10,5" -> 10.5). */
function parsePct(entity: any): number | null {
  if (!entity) return null;
  // Si el procesador devuelve normalizedValue, usarlo (mas fiable).
  const norm = entity.normalizedValue?.text;
  const raw = (norm ?? entity.mentionText ?? "").replace(/[^\d.,]/g, "").replace(",", ".");
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

/**
 * Extrae todas las lineas de IVA desde las entidades de Document AI.
 *
 * Document AI Invoice Parser devuelve tipo "vat" como entidad COMPUESTA
 * con `properties: [{ type: "vat/tax_rate", ... }, { type: "vat/tax_amount", ... }, ...]`.
 * Cuando la factura tiene varios tipos hay varias entidades "vat" — cada una
 * un tipo. Iteramos sobre todas para construir el desglose completo.
 *
 * Fallback: si el procesador devuelve los tipos planos (vat_tax_rate +
 * vat_tax_amount al nivel raiz, una sola linea), montamos una linea unica.
 */
function extractVatLines(entities: any[]): ExtractedVatLine[] {
  const lines: ExtractedVatLine[] = [];

  // 1) Entidades "vat" compuestas (multi-IVA). Cada vat tiene properties.
  const vatEntities = entities.filter((e) => e.type === "vat");
  for (const vat of vatEntities) {
    const props: any[] = vat.properties ?? [];
    const rateEnt = props.find((p) => p.type === "vat/tax_rate");
    const amountEnt = props.find((p) => p.type === "vat/tax_amount");
    const baseEnt = props.find(
      (p) => p.type === "vat/taxable_amount" || p.type === "vat/net_amount",
    );

    const rate = parsePct(rateEnt);
    const amount = getMoney(amountEnt);
    let base = getMoney(baseEnt);

    // Si la base no viene explicita pero tenemos rate + amount, derivamos.
    // amount = base * rate / 100  =>  base = amount * 100 / rate
    if (base == null && rate != null && rate !== 0 && amount != null) {
      base = parseFloat(((amount * 100) / rate).toFixed(2));
    }

    if (rate != null && amount != null && base != null) {
      lines.push({ taxBase: base, vatRate: rate, vatAmount: amount });
    }
  }

  // 2) Si no hubo composites, intentamos los tipos planos (procesador
  //    antiguo con un solo tipo de IVA por factura).
  if (lines.length === 0) {
    const flatRate = parsePct(
      entities.find((e) => e.type === "vat_tax_rate") ??
        entities.find((e) => e.type === "vat"),
    );
    const flatAmount =
      getMoney(entities.find((e) => e.type === "vat_tax_amount")) ??
      getMoney(entities.find((e) => e.type === "total_tax_amount"));
    const flatBase = getMoney(entities.find((e) => e.type === "net_amount"));

    if (flatRate != null && flatAmount != null && flatBase != null) {
      lines.push({ taxBase: flatBase, vatRate: flatRate, vatAmount: flatAmount });
    }
  }

  return lines;
}

/**
 * Mapea las entidades que devuelve Document AI Invoice Parser
 * a nuestro tipo ExtractedInvoice, incluyendo scores de confianza.
 */
function mapEntities(entities: any[]): ExtractedInvoice {
  const byType = (type: string) => entities.find((e) => e.type === type);
  const text = (type: string) => byType(type)?.mentionText?.trim() ?? null;

  // Build confidence map from entity confidence scores
  const confidence: Record<string, number> = {};
  for (const f of ALL_FIELDS) confidence[f] = 0.0; // default: not found
  for (const entity of entities) {
    const field = ENTITY_TO_FIELD[entity.type];
    if (field && entity.confidence != null) {
      // Keep highest confidence if multiple entities map to same field
      confidence[field] = Math.max(confidence[field], entity.confidence);
    }
    // Las entidades "vat" compuestas tienen su confidence en raiz; tambien
    // alimentamos vatRate/vatAmount con ella para que el gestor vea algo.
    if (entity.type === "vat" && entity.confidence != null) {
      confidence["vatRate"] = Math.max(confidence["vatRate"] ?? 0, entity.confidence);
      confidence["vatAmount"] = Math.max(confidence["vatAmount"] ?? 0, entity.confidence);
    }
  }
  // IRPF is not extracted by Document AI, mark as 0
  confidence["irpfRate"] = 0.0;
  confidence["irpfAmount"] = 0.0;

  // Desglose de IVA: una linea por tipo (Document AI devuelve N "vat"
  // entities cuando hay varios tipos en la factura).
  const vatLines = extractVatLines(entities);

  // Totales agregados denormalizados sobre Invoice. Si hay desglose usamos
  // la suma; si no, caemos al total reportado por Document AI directamente.
  const sumBases = vatLines.length > 0
    ? parseFloat(vatLines.reduce((s, l) => s + l.taxBase, 0).toFixed(2))
    : getMoney(byType("net_amount"));
  const sumAmounts = vatLines.length > 0
    ? parseFloat(vatLines.reduce((s, l) => s + l.vatAmount, 0).toFixed(2))
    : getMoney(byType("vat_tax_amount")) ?? getMoney(byType("total_tax_amount"));
  // vatRate denormalizado solo cuando hay UNA linea (multi-IVA -> null
  // para que la UI sepa que el desglose tiene la verdad).
  const denormVatRate = vatLines.length === 1 ? vatLines[0].vatRate : null;

  return {
    issuerName:    text("supplier_name"),
    issuerCif:     text("supplier_tax_id")?.replace(/\s/g, "") ?? null,
    receiverName:  text("receiver_name"),
    receiverCif:   text("receiver_tax_id")?.replace(/\s/g, "") ?? null,
    invoiceNumber: text("invoice_id"),
    invoiceDate:   getDate(byType("invoice_date")),
    taxBase:       sumBases,
    vatRate:       denormVatRate,
    vatAmount:     sumAmounts,
    irpfRate:      null,
    irpfAmount:    null,
    totalAmount:   getMoney(byType("total_amount")),
    vatLines,
    confidence,
  };
}

/** Resultado de OCR: campos extraidos + respuesta cruda para auditoria/debug. */
export type OcrResult = {
  extracted: ExtractedInvoice;
  /** JSON original del proveedor OCR (Document AI, XML facturae crudo). */
  rawJson: string;
};

/**
 * Parser de texto: cuando Document AI no devuelve multi-IVA estructurado
 * pero el texto del documento sí lo contiene (caso muy comun en tickets
 * espanoles), buscamos pares "Base XX%: NNN,NN" / "Cuota IVA XX%: NNN,NN".
 *
 * Devuelve [] si no encuentra al menos 2 lineas (con 1 sola asumimos que
 * Doc AI ya nos lo dio agregado y no aportamos nada).
 */
function parseVatLinesFromText(text: string): ExtractedVatLine[] {
  if (!text) return [];

  // Capturamos: rate (entero o decimal) y amount con coma o punto decimal.
  const num = "(\\d+(?:[.,]\\d+)?)";
  // "Base 4%: 58,52" o "Base imponible 4%   58,52"
  const baseRe = new RegExp(
    `base[\\s\\S]{0,30}?${num}\\s*%[\\s\\S]{0,15}?${num}\\s*(?:€|EUR)?`,
    "gi",
  );
  // "Cuota IVA 4%: 2,34" — admite "IVA" o "I.V.A." o solo "Cuota"
  const cuotaRe = new RegExp(
    `cuota(?:\\s*(?:i\\.?v\\.?a\\.?))?[\\s\\S]{0,30}?${num}\\s*%[\\s\\S]{0,15}?${num}\\s*(?:€|EUR)?`,
    "gi",
  );

  const toNum = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", "."));

  // Mapa rate -> base, rate -> cuota. Asi emparejamos por tipo.
  const bases = new Map<number, number>();
  const cuotas = new Map<number, number>();

  for (const m of text.matchAll(baseRe)) {
    const rate = toNum(m[1]);
    const amt = toNum(m[2]);
    if (!isNaN(rate) && !isNaN(amt) && rate > 0 && rate < 100) {
      bases.set(rate, amt);
    }
  }
  for (const m of text.matchAll(cuotaRe)) {
    const rate = toNum(m[1]);
    const amt = toNum(m[2]);
    if (!isNaN(rate) && !isNaN(amt) && rate > 0 && rate < 100) {
      cuotas.set(rate, amt);
    }
  }

  const lines: ExtractedVatLine[] = [];
  // Solo tipos donde tenemos AMBOS base y cuota (son consistentes).
  for (const [rate, base] of bases) {
    const cuota = cuotas.get(rate);
    if (cuota == null) continue;
    // Sanity check aritmetico: cuota debe ser ~ base * rate / 100 (tolerancia 5%).
    const expected = (base * rate) / 100;
    if (expected > 0 && Math.abs(cuota - expected) / expected > 0.05) continue;
    lines.push({ taxBase: base, vatRate: rate, vatAmount: cuota });
  }

  // Solo devolvemos si hay >= 2 lineas. Con 1 ya estaba agregado.
  if (lines.length < 2) return [];
  // Ordenamos por % ascendente para que la UI sea consistente.
  lines.sort((a, b) => a.vatRate - b.vatRate);
  return lines;
}

/** Llama a la API REST de Document AI y devuelve los datos extraídos. */
async function extractWithDocumentAI(
  base64: string,
  mimeType: string,
): Promise<OcrResult> {
  const token      = await getAccessToken();
  const location   = process.env.GOOGLE_DOCUMENT_AI_LOCATION ?? "eu";
  const projectId  = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;

  if (!projectId || !processorId) {
    throw new Error("Faltan GOOGLE_CLOUD_PROJECT_ID o GOOGLE_DOCUMENT_AI_PROCESSOR_ID");
  }

  const url =
    `https://${location}-documentai.googleapis.com/v1` +
    `/projects/${projectId}/locations/${location}/processors/${processorId}:process`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: { content: base64, mimeType },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Document AI respondió ${res.status}: ${err}`);
  }

  const data = await res.json();
  const entities: any[] = data.document?.entities ?? [];
  const text: string = data.document?.text ?? "";

  const extracted = mapEntities(entities);

  // Fallback: si Doc AI no nos dio multi-IVA pero el texto del documento
  // contiene "Base X%: N / Cuota IVA X%: N", lo extraemos del texto.
  if (extracted.vatLines.length <= 1) {
    const fromText = parseVatLinesFromText(text);
    if (fromText.length >= 2) {
      extracted.vatLines = fromText;
      // Recalculamos los totales desde el desglose nuevo.
      extracted.taxBase = parseFloat(
        fromText.reduce((s, l) => s + l.taxBase, 0).toFixed(2),
      );
      extracted.vatAmount = parseFloat(
        fromText.reduce((s, l) => s + l.vatAmount, 0).toFixed(2),
      );
      // Multi-IVA -> el rate denormalizado deja de tener sentido.
      extracted.vatRate = null;
      // Subimos confianza de los campos VAT a la del Doc AI agregado o 0.9
      // si no habia nada (el texto coincide aritmeticamente con la cuota).
      const c = extracted.confidence ?? {};
      c.vatRate = Math.max(c.vatRate ?? 0, 0.9);
      c.vatAmount = Math.max(c.vatAmount ?? 0, 0.9);
      c.taxBase = Math.max(c.taxBase ?? 0, 0.9);
      extracted.confidence = c;
    }
  }

  return {
    extracted,
    // Guardamos solo entities + text para acotar tamano (data.document
    // entera puede ser MB con todos los tokens/pages/symbols).
    rawJson: JSON.stringify({ entities, text }),
  };
}

/** PDF — procesado por Document AI Invoice Parser */
export async function extractInvoiceFromPdf(base64: string): Promise<OcrResult> {
  return extractWithDocumentAI(base64, "application/pdf");
}

/** Imagen (JPG/PNG/WEBP) — procesada por Document AI Invoice Parser */
export async function extractInvoiceFromImage(
  base64: string,
  mimeType: string,
): Promise<OcrResult> {
  return extractWithDocumentAI(base64, mimeType || "image/jpeg");
}

/** XML FacturaE — parse nativo con fast-xml-parser */
export async function extractInvoiceFromXml(xml: string): Promise<OcrResult> {
  const extracted = await parseFacturaeXml(xml);
  return { extracted, rawJson: xml };
}

async function parseFacturaeXml(xml: string): Promise<ExtractedInvoice> {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const doc = parser.parse(xml);

  // Navigate FacturaE structure (v3.2 / v3.2.2)
  const facturae = doc.Facturae ?? doc.facturae ?? doc;
  const parties = facturae?.Parties ?? facturae?.parties;
  const invoices = facturae?.Invoices ?? facturae?.invoices;
  const invoiceNode = invoices?.Invoice ?? invoices?.invoice;
  const inv = Array.isArray(invoiceNode) ? invoiceNode[0] : invoiceNode;

  // Seller (issuer)
  const seller = parties?.SellerParty ?? parties?.sellerParty;
  const sellerTax = seller?.TaxIdentification ?? seller?.taxIdentification;
  const sellerEntity = seller?.LegalEntity ?? seller?.Individual ?? seller?.legalEntity;

  // Buyer (receiver)
  const buyer = parties?.BuyerParty ?? parties?.buyerParty;
  const buyerTax = buyer?.TaxIdentification ?? buyer?.taxIdentification;
  const buyerEntity = buyer?.LegalEntity ?? buyer?.Individual ?? buyer?.legalEntity;

  // Invoice header
  const header = inv?.InvoiceHeader ?? inv?.invoiceHeader;
  const totals = inv?.InvoiceTotals ?? inv?.invoiceTotals;

  // Tax lines (IVA repercutido). Facturae permite multiples tipos.
  const taxesOutputs = inv?.TaxesOutputs ?? inv?.taxesOutputs;
  const taxLine = taxesOutputs?.Tax ?? taxesOutputs?.tax;
  const allTaxLines = taxLine ? (Array.isArray(taxLine) ? taxLine : [taxLine]) : [];
  const firstTax = allTaxLines[0];

  const taxesWithheld = inv?.TaxesWithheld ?? inv?.taxesWithheld;
  const withheldLine = taxesWithheld?.Tax ?? taxesWithheld?.tax;
  const firstWithheld = Array.isArray(withheldLine) ? withheldLine[0] : withheldLine;

  const safeNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return isNaN(n) ? null : n;
  };
  const safeStr = (v: unknown): string | null =>
    v != null ? String(v).trim() || null : null;

  // All fields from XML are deterministic → confidence 1.0
  const confidence: Record<string, number> = {};
  for (const f of ALL_FIELDS) confidence[f] = 1.0;

  // Mapear todas las lineas de IVA. Si alguna esta incompleta la dejamos
  // fuera (mejor que tener basura en la suma).
  const vatLines: ExtractedVatLine[] = [];
  for (const t of allTaxLines) {
    const b = safeNum(t?.TaxableBase?.TotalAmount ?? t?.taxableBase?.totalAmount);
    const r = safeNum(t?.TaxRate ?? t?.taxRate);
    const a = safeNum(t?.TaxAmount?.TotalAmount ?? t?.taxAmount?.totalAmount);
    if (b != null && r != null && a != null) {
      vatLines.push({ taxBase: b, vatRate: r, vatAmount: a });
    }
  }

  // Totales agregados: si tenemos lineas usamos la suma; si no, caemos a
  // los totales declarados en el XML (compatibilidad con docs antiguos).
  const sumBases = vatLines.length > 0
    ? vatLines.reduce((s, l) => s + l.taxBase, 0)
    : null;
  const sumAmounts = vatLines.length > 0
    ? vatLines.reduce((s, l) => s + l.vatAmount, 0)
    : null;

  return {
    issuerName:    safeStr(sellerEntity?.CorporateName ?? sellerEntity?.corporateName
                     ?? sellerEntity?.Name ?? sellerEntity?.name),
    issuerCif:     safeStr(sellerTax?.TaxIdentificationNumber ?? sellerTax?.taxIdentificationNumber),
    receiverName:  safeStr(buyerEntity?.CorporateName ?? buyerEntity?.corporateName
                     ?? buyerEntity?.Name ?? buyerEntity?.name),
    receiverCif:   safeStr(buyerTax?.TaxIdentificationNumber ?? buyerTax?.taxIdentificationNumber),
    invoiceNumber: safeStr(header?.InvoiceNumber ?? header?.invoiceNumber
                     ?? header?.InvoiceSeriesCode ?? header?.invoiceSeriesCode),
    invoiceDate:   safeStr(header?.IssueDate ?? header?.issueDate),
    taxBase:       sumBases ?? safeNum(totals?.TotalGrossAmountBeforeTaxes ?? totals?.totalGrossAmountBeforeTaxes
                     ?? firstTax?.TaxableBase?.TotalAmount ?? firstTax?.taxableBase?.totalAmount),
    vatRate:       vatLines.length === 1 ? vatLines[0].vatRate : safeNum(firstTax?.TaxRate ?? firstTax?.taxRate),
    vatAmount:     sumAmounts ?? safeNum(firstTax?.TaxAmount?.TotalAmount ?? firstTax?.taxAmount?.totalAmount),
    irpfRate:      safeNum(firstWithheld?.TaxRate ?? firstWithheld?.taxRate),
    irpfAmount:    safeNum(firstWithheld?.TaxAmount?.TotalAmount ?? firstWithheld?.taxAmount?.totalAmount
                     ?? totals?.TotalTaxesWithheld ?? totals?.totalTaxesWithheld),
    totalAmount:   safeNum(totals?.InvoiceTotal ?? totals?.invoiceTotal),
    vatLines,
    confidence,
  };
}
