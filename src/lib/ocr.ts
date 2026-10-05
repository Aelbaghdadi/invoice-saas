import { DocumentError } from "./ocrErrors";
import { XMLParser } from "fast-xml-parser";
import { normalizeCurrency } from "./currency";
import type { IntracomGoodsTypeName } from "./validators";

/** Una linea del desglose de IVA. Una factura con varios tipos
 *  (4% + 10% + 21%) tiene varias lineas. Cuando la factura tiene un
 *  unico tipo, vatLines tiene una sola entrada. */
export type ExtractedVatLine = {
  taxBase:   number;
  vatRate:   number;
  vatAmount: number;
  /** % y cuota de Recargo de Equivalencia de ESTA linea, SOLO si el
   *  documento los menciona explicitamente ("Recargo de Equivalencia",
   *  "R.E."...) para este tipo de IVA. null en el resto de casos — nunca se
   *  derivan del % de IVA en esta capa (eso, cuando procede, lo decide
   *  processInvoice a partir de Client.equivalenceSurchargeCustomer). */
  equivalenceSurchargeRate?:   number | null;
  equivalenceSurchargeAmount?: number | null;
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
  /** Moneda ISO 4217 de los importes (EUR, USD...). null si no se detecto. */
  currency:      string | null;
  /** Si lo facturado son BIENES o SERVICIOS segun la IA. Solo se usa en
   *  intracomunitarias (compras 3/8, ventas cuenta 700/705); null si no lo sabe. */
  supplyType: IntracomGoodsTypeName | null;
  /** Facturae: el XML dice que es rectificativa (InvoiceClass OR/CR o bloque
   *  Corrective). Cuenta como la mencion en el texto de un PDF (F-012). */
  isCorrective?: boolean;
  /** Desglose de IVA. Vacio si no se pudo extraer. */
  vatLines:      ExtractedVatLine[];
  confidence:    Record<string, number> | null;
};

/** All extraction field names for confidence mapping */
const ALL_FIELDS = [
  "issuerName", "issuerCif", "receiverName", "receiverCif",
  "invoiceNumber", "invoiceDate", "taxBase", "vatRate",
  "vatAmount", "irpfRate", "irpfAmount", "totalAmount",
];

/** Resultado de OCR: campos extraidos + respuesta cruda para auditoria/debug. */
export type OcrResult = {
  extracted: ExtractedInvoice;
  /** Respuesta original del extractor (JSON de Gemini, XML facturae crudo). */
  rawJson: string;
  /** Texto plano extraído del documento (solo PDF/imagen). Undefined para XML. */
  rawText?: string;
};

/** XML FacturaE — parse nativo con fast-xml-parser */
export async function extractInvoiceFromXml(xml: string): Promise<OcrResult> {
  const extracted = await parseFacturaeXml(xml);
  return { extracted, rawJson: xml };
}

/** ¿Es rectificativa la factura de un Facturae? InvoiceClass OR (original
 *  rectificativa) o CR (copia rectificativa), o el bloque Corrective de la
 *  cabecera. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- nodo de fast-xml-parser
function facturaeInvoiceIsCorrective(inv: any): boolean {
  const header = inv?.InvoiceHeader ?? inv?.invoiceHeader;
  const invoiceClass = String(header?.InvoiceClass ?? header?.invoiceClass ?? "").trim().toUpperCase();
  return invoiceClass === "OR" || invoiceClass === "CR" || (header?.Corrective ?? header?.corrective) != null;
}

/** ¿El XML Facturae guardado es de una rectificativa? Para classifyInvoice,
 *  que solo tiene el XML crudo de la extraccion. Busca en el texto en vez de
 *  parsear: con un adjunto de 18 MB, parsear eran 2,9 s de event loop y
 *  750 MB de memoria. */
export function facturaeXmlIsCorrective(xml: string): boolean {
  return /<(?:[\w-]+:)?InvoiceClass>\s*(?:OR|CR)\s*<\/|<(?:[\w-]+:)?Corrective[\s/>]/i.test(xml);
}

/** «2026-09-14», «2026-09-14+02:00» o «2026-09-14T10:00:00Z» -> «2026-09-14». */
function calendarDay(value: string | null): string | null {
  return value?.match(/^\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? value;
}

async function parseFacturaeXml(xml: string): Promise<ExtractedInvoice> {
  // parseTagValue: false deja los valores como texto. Si no, «0042» se leia
  // como 42, «1.10» como 1.1 y «12E4» como 120000: el numero de factura
  // llegaba alterado a A3. Los importes pasan igual por safeNum.
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
  const doc = parser.parse(xml);

  // Navigate FacturaE structure (v3.2 / v3.2.2)
  const facturae = doc.Facturae ?? doc.facturae ?? doc;
  const parties = facturae?.Parties ?? facturae?.parties;
  const invoices = facturae?.Invoices ?? facturae?.invoices;
  const invoiceNode = invoices?.Invoice ?? invoices?.invoice;
  // Un lote con varias facturas: antes se leia solo la primera y el resto se
  // perdia sin avisar. Es determinista (no se reintenta) y se dice.
  if (Array.isArray(invoiceNode) && invoiceNode.length > 1) {
    throw new DocumentError(`El XML trae ${invoiceNode.length} facturas (lote): súbelas por separado.`);
  }
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
  // En Facturae 3.2 / 3.2.2 la fecha de emision va en InvoiceIssueData; solo
  // se buscaba en InvoiceHeader y la de un XML real no se leia.
  const issueData = inv?.InvoiceIssueData ?? inv?.invoiceIssueData;
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

  // Sociedad: CorporateName. Persona fisica (Individual): nombre y los dos
  // apellidos; antes se guardaba solo «Juan», y eso iba a la columna F.
  const partyName = (entity: Record<string, unknown> | null | undefined): string | null => {
    const corporate = safeStr(entity?.CorporateName ?? entity?.corporateName);
    if (corporate) return corporate;
    const parts = [
      entity?.Name ?? entity?.name,
      entity?.FirstSurname ?? entity?.firstSurname,
      entity?.SecondSurname ?? entity?.secondSurname,
    ].map(safeStr).filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  };

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
    issuerName:    partyName(sellerEntity),
    issuerCif:     safeStr(sellerTax?.TaxIdentificationNumber ?? sellerTax?.taxIdentificationNumber),
    receiverName:  partyName(buyerEntity),
    receiverCif:   safeStr(buyerTax?.TaxIdentificationNumber ?? buyerTax?.taxIdentificationNumber),
    invoiceNumber: safeStr(header?.InvoiceNumber ?? header?.invoiceNumber
                     ?? header?.InvoiceSeriesCode ?? header?.invoiceSeriesCode),
    // Solo el dia del calendario: con zona («2026-09-14+02:00») daba Invalid
    // Date y la factura se guardaba sin fecha.
    invoiceDate:   calendarDay(safeStr(issueData?.IssueDate ?? issueData?.issueDate ?? header?.IssueDate ?? header?.issueDate)),
    taxBase:       sumBases ?? safeNum(totals?.TotalGrossAmountBeforeTaxes ?? totals?.totalGrossAmountBeforeTaxes
                     ?? firstTax?.TaxableBase?.TotalAmount ?? firstTax?.taxableBase?.totalAmount),
    vatRate:       vatLines.length === 1 ? vatLines[0].vatRate : safeNum(firstTax?.TaxRate ?? firstTax?.taxRate),
    vatAmount:     sumAmounts ?? safeNum(firstTax?.TaxAmount?.TotalAmount ?? firstTax?.taxAmount?.totalAmount),
    irpfRate:      safeNum(firstWithheld?.TaxRate ?? firstWithheld?.taxRate),
    irpfAmount:    safeNum(firstWithheld?.TaxAmount?.TotalAmount ?? firstWithheld?.taxAmount?.totalAmount
                     ?? totals?.TotalTaxesWithheld ?? totals?.totalTaxesWithheld),
    totalAmount:   safeNum(totals?.InvoiceTotal ?? totals?.invoiceTotal),
    currency:      normalizeCurrency(
      issueData?.InvoiceCurrencyCode ?? issueData?.invoiceCurrencyCode
      ?? facturae?.FileHeader?.Batch?.InvoiceCurrencyCode ?? facturae?.fileHeader?.batch?.invoiceCurrencyCode,
    ),
    isCorrective: facturaeInvoiceIsCorrective(inv),
    // El recargo de equivalencia va dentro del mismo Tax de IVA
    // (EquivalenceSurcharge y EquivalenceSurchargeAmount), no como otra
    // linea. Todavia no se mapea (tarea aparte): las lineas quedan sin ese
    // dato y el gestor lo introduce a mano si aplica.
    // Facturae no marca si las lineas son bienes o servicios.
    supplyType: null,
    vatLines,
    confidence,
  };
}
