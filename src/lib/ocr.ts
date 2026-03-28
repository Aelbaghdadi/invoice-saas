import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const SYSTEM_PROMPT = `Eres un motor OCR especializado en facturas españolas.
Extrae los campos y devuelve ÚNICAMENTE este JSON (sin texto adicional):
{"issuerName":null,"issuerCif":null,"receiverName":null,"receiverCif":null,"invoiceNumber":null,"invoiceDate":null,"taxBase":null,"vatRate":null,"vatAmount":null,"irpfRate":null,"irpfAmount":null,"totalAmount":null}
Reglas:
- CIF/NIF sin espacios (ej: B12345678)
- Importes como número decimal sin símbolo (ej: 1210.50)
- Fecha como YYYY-MM-DD
- Si un campo no aparece → null`;

const EMPTY: ExtractedInvoice = {
  issuerName: null, issuerCif: null, receiverName: null, receiverCif: null,
  invoiceNumber: null, invoiceDate: null, taxBase: null, vatRate: null,
  vatAmount: null, irpfRate: null, irpfAmount: null, totalAmount: null,
};

function parseJson(raw: string): ExtractedInvoice {
  try {
    const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    return JSON.parse(json) as ExtractedInvoice;
  } catch {
    return EMPTY;
  }
}

/** PDF via OpenAI Responses API (native PDF support) */
export async function extractInvoiceFromPdf(base64: string): Promise<ExtractedInvoice> {
  const response = await openai.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "factura.pdf",
            file_data: `data:application/pdf;base64,${base64}`,
          } as never,
          { type: "input_text", text: SYSTEM_PROMPT },
        ],
      },
    ],
    max_output_tokens: 800,
  });

  const raw = (response as unknown as { output: { content: { text: string }[] }[] })
    .output?.[0]?.content?.[0]?.text ?? "{}";
  return parseJson(raw);
}

/** Image (JPG/PNG/WEBP) via Chat Completions */
export async function extractInvoiceFromImage(
  base64: string,
  mimeType: string
): Promise<ExtractedInvoice> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 800,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
          },
          { type: "text", text: "Extrae los datos de esta factura." },
        ],
      },
    ],
  });
  return parseJson(response.choices[0]?.message?.content ?? "{}");
}

/** XML FacturaE — parse directamente sin IA */
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
