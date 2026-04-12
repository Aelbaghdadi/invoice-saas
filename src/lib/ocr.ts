import { GoogleAuth } from "google-auth-library";
import { XMLParser } from "fast-xml-parser";

export type ExtractedInvoice = {
  issuerName:    string | null;
  issuerCif:     string | null;
  receiverName:  string | null;
  receiverCif:   string | null;
  invoiceNumber: string | null;
  invoiceDate:   string | null; // YYYY-MM-DD
  taxBase:       number | null;
  vatRate:       number | null;
  vatAmount:     number | null;
  irpfRate:      number | null;
  irpfAmount:    number | null;
  totalAmount:   number | null;
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

/**
 * Mapea las entidades que devuelve Document AI Invoice Parser
 * a nuestro tipo ExtractedInvoice, incluyendo scores de confianza.
 */
function mapEntities(entities: any[]): ExtractedInvoice {
  const byType = (type: string) => entities.find((e) => e.type === type);
  const text = (type: string) => byType(type)?.mentionText?.trim() ?? null;

  // El porcentaje de IVA puede venir como "vat_tax_rate" dependiendo del procesador
  const vatRateEntity = byType("vat_tax_rate") ?? byType("vat");
  const vatRate = (() => {
    if (!vatRateEntity) return null;
    const raw = vatRateEntity.mentionText?.replace(/[^\d.,]/g, "").replace(",", ".");
    return raw ? parseFloat(raw) : null;
  })();

  // Build confidence map from entity confidence scores
  const confidence: Record<string, number> = {};
  for (const f of ALL_FIELDS) confidence[f] = 0.0; // default: not found
  for (const entity of entities) {
    const field = ENTITY_TO_FIELD[entity.type];
    if (field && entity.confidence != null) {
      // Keep highest confidence if multiple entities map to same field
      confidence[field] = Math.max(confidence[field], entity.confidence);
    }
  }
  // IRPF is not extracted by Document AI, mark as 0
  confidence["irpfRate"] = 0.0;
  confidence["irpfAmount"] = 0.0;

  return {
    issuerName:    text("supplier_name"),
    issuerCif:     text("supplier_tax_id")?.replace(/\s/g, "") ?? null,
    receiverName:  text("receiver_name"),
    receiverCif:   text("receiver_tax_id")?.replace(/\s/g, "") ?? null,
    invoiceNumber: text("invoice_id"),
    invoiceDate:   getDate(byType("invoice_date")),
    taxBase:       getMoney(byType("net_amount")),
    vatRate,
    vatAmount:     getMoney(byType("vat_tax_amount")) ?? getMoney(byType("total_tax_amount")),
    irpfRate:      null,
    irpfAmount:    null,
    totalAmount:   getMoney(byType("total_amount")),
    confidence,
  };
}

/** Llama a la API REST de Document AI y devuelve los datos extraídos */
async function extractWithDocumentAI(
  base64: string,
  mimeType: string,
): Promise<ExtractedInvoice> {
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
  return mapEntities(entities);
}

/** PDF — procesado por Document AI Invoice Parser */
export async function extractInvoiceFromPdf(base64: string): Promise<ExtractedInvoice> {
  return extractWithDocumentAI(base64, "application/pdf");
}

/** Imagen (JPG/PNG/WEBP) — procesada por Document AI Invoice Parser */
export async function extractInvoiceFromImage(
  base64: string,
  mimeType: string,
): Promise<ExtractedInvoice> {
  return extractWithDocumentAI(base64, mimeType || "image/jpeg");
}

/** XML FacturaE — parse nativo con fast-xml-parser */
export async function extractInvoiceFromXml(xml: string): Promise<ExtractedInvoice> {
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

  // Tax lines
  const taxesOutputs = inv?.TaxesOutputs ?? inv?.taxesOutputs;
  const taxLine = taxesOutputs?.Tax ?? taxesOutputs?.tax;
  const firstTax = Array.isArray(taxLine) ? taxLine[0] : taxLine;

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
    taxBase:       safeNum(totals?.TotalGrossAmountBeforeTaxes ?? totals?.totalGrossAmountBeforeTaxes
                     ?? firstTax?.TaxableBase?.TotalAmount ?? firstTax?.taxableBase?.totalAmount),
    vatRate:       safeNum(firstTax?.TaxRate ?? firstTax?.taxRate),
    vatAmount:     safeNum(firstTax?.TaxAmount?.TotalAmount ?? firstTax?.taxAmount?.totalAmount),
    irpfRate:      safeNum(firstWithheld?.TaxRate ?? firstWithheld?.taxRate),
    irpfAmount:    safeNum(firstWithheld?.TaxAmount?.TotalAmount ?? firstWithheld?.taxAmount?.totalAmount
                     ?? totals?.TotalTaxesWithheld ?? totals?.totalTaxesWithheld),
    totalAmount:   safeNum(totals?.InvoiceTotal ?? totals?.invoiceTotal),
    confidence,
  };
}
