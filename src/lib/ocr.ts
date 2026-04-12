import { GoogleAuth } from "google-auth-library";

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
};

const EMPTY: ExtractedInvoice = {
  issuerName: null, issuerCif: null, receiverName: null, receiverCif: null,
  invoiceNumber: null, invoiceDate: null, taxBase: null, vatRate: null,
  vatAmount: null, irpfRate: null, irpfAmount: null, totalAmount: null,
};

/** Obtiene un access token de Google usando las credenciales de la variable de entorno */
async function getAccessToken(): Promise<string> {
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credJson) throw new Error("Falta la variable GOOGLE_APPLICATION_CREDENTIALS_JSON");

  const credentials = JSON.parse(credJson);
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

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

/**
 * Mapea las entidades que devuelve Document AI Invoice Parser
 * a nuestro tipo ExtractedInvoice.
 *
 * Tipos de entidad relevantes del Invoice Parser:
 * https://cloud.google.com/document-ai/docs/processors-list#specialized_processors
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

  return {
    issuerName:    text("supplier_name"),
    issuerCif:     text("supplier_tax_id")?.replace(/\s/g, "") ?? null,
    receiverName:  text("receiver_name"),
    receiverCif:   text("receiver_tax_id")?.replace(/\s/g, "") ?? null,
    invoiceNumber: text("invoice_id"),
    invoiceDate:   getDate(byType("invoice_date")),
    taxBase:       getMoney(byType("net_amount")),
    vatRate,
    // "vat_tax_amount" es la cuota de IVA; "total_tax_amount" es el total de impuestos
    vatAmount:     getMoney(byType("vat_tax_amount")) ?? getMoney(byType("total_tax_amount")),
    // IRPF es una retención fiscal española que Document AI (procesador genérico) no extrae.
    // El worker lo completará manualmente en la pantalla de revisión.
    irpfRate:      null,
    irpfAmount:    null,
    totalAmount:   getMoney(byType("total_amount")),
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

/** XML FacturaE — parse directo sin IA (sin cambios) */
export async function extractInvoiceFromXml(xml: string): Promise<ExtractedInvoice> {
  const get = (tag: string) =>
    xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i"))?.[1]?.trim() ?? null;
  const num = (tag: string) => {
    const v = get(tag);
    return v ? parseFloat(v) : null;
  };
  return {
    issuerName:    get("CorporateName") ?? get("Name"),
    issuerCif:     get("TaxIdentificationNumber"),
    receiverName:  null,
    receiverCif:   null,
    invoiceNumber: get("InvoiceNumber") ?? get("InvoiceSeriesCode"),
    invoiceDate:   get("IssueDate"),
    taxBase:       num("TotalGrossAmountBeforeTaxes") ?? num("TaxableBase"),
    vatRate:       num("TaxRate"),
    vatAmount:     num("TaxAmount"),
    irpfRate:      null,
    irpfAmount:    num("WithholdingAmount"),
    totalAmount:   num("InvoiceTotal"),
  };
}
