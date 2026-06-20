import type { OcrResult, ExtractedInvoice, ExtractedVatLine } from "./ocr";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

// PDFs con menos de este umbral de caracteres se consideran escaneados
const MIN_TEXT_CHARS = 100;

/**
 * Extrae texto plano de un PDF usando pdfjs-dist en servidor (sin worker).
 * Devuelve string vacío si el PDF está escaneado o si hay un error de lectura.
 */
async function extractPdfText(base64: string): Promise<string> {
  try {
    // Importación dinámica para evitar problemas con el worker en SSR
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = "";

    const buffer = Buffer.from(base64, "base64");
    const pdf = await (pdfjsLib as any).getDocument({
      data: new Uint8Array(buffer),
    }).promise;

    let text = "";
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      text +=
        (content.items as any[])
          .map((item: any) => ("str" in item ? item.str : ""))
          .join(" ") + "\n";
    }
    return text.trim();
  } catch {
    return "";
  }
}

const EXTRACTION_PROMPT = `Eres un extractor de facturas españolas. Extrae los campos y devuelve SOLO un JSON válido con esta estructura exacta, sin texto adicional:

{
  "issuerName": "Razón social del emisor o null",
  "issuerCif": "NIF/CIF del emisor sin espacios o null",
  "receiverName": "Razón social del receptor o null",
  "receiverCif": "NIF/CIF del receptor sin espacios o null",
  "invoiceNumber": "Número de factura o null",
  "invoiceDate": "Fecha en YYYY-MM-DD o null",
  "taxBase": 0.00,
  "vatRate": 21,
  "vatAmount": 0.00,
  "irpfRate": null,
  "irpfAmount": null,
  "totalAmount": 0.00,
  "vatLines": [
    { "taxBase": 0.00, "vatRate": 21, "vatAmount": 0.00 }
  ],
  "confidence": {
    "issuerName": 0.9, "issuerCif": 0.9,
    "receiverName": 0.8, "receiverCif": 0.8,
    "invoiceNumber": 0.95, "invoiceDate": 0.95,
    "taxBase": 0.9, "vatRate": 0.9, "vatAmount": 0.9,
    "irpfRate": 0.0, "irpfAmount": 0.0, "totalAmount": 0.95
  }
}

Reglas:
- vatRate: null si hay múltiples tipos de IVA; incluirlos todos en vatLines
- vatLines: una entrada por tipo de IVA (4%, 10%, 21%, etc.)
- irpfRate/irpfAmount: solo si aparece retención explícita en la factura
- confidence: 0.0-1.0 según tu certeza; 0.0 para campos no encontrados
- invoiceDate: siempre YYYY-MM-DD
- CIFs sin espacios ni guiones`;

/** Llama a la API de Gemini Flash con las partes del mensaje. */
async function callGemini(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
): Promise<ExtractedInvoice> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta GEMINI_API_KEY en las variables de entorno");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 1024,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Flash respondió ${res.status}: ${err}`);
  }

  const data = await res.json();
  const rawText: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!rawText) throw new Error("Gemini no devolvió contenido en la respuesta");

  return parseGeminiResponse(rawText);
}

/** Parsea y normaliza el JSON que devuelve Gemini al tipo ExtractedInvoice. */
function parseGeminiResponse(raw: string): ExtractedInvoice {
  let parsed: any;
  try {
    // Gemini a veces envuelve en ```json ... ```, limpiar si ocurre
    const clean = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(clean);
  } catch {
    throw new Error(`JSON inválido de Gemini: ${raw.slice(0, 300)}`);
  }

  const num = (v: any): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? null : n;
  };
  const str = (v: any): string | null =>
    v != null && String(v).trim() ? String(v).trim() : null;

  const ALL_FIELDS = [
    "issuerName", "issuerCif", "receiverName", "receiverCif",
    "invoiceNumber", "invoiceDate", "taxBase", "vatRate",
    "vatAmount", "irpfRate", "irpfAmount", "totalAmount",
  ];
  const confidence: Record<string, number> = {};
  for (const f of ALL_FIELDS) confidence[f] = num(parsed.confidence?.[f]) ?? 0;

  const vatLines: ExtractedVatLine[] = (Array.isArray(parsed.vatLines) ? parsed.vatLines : [])
    .map((l: any) => ({
      taxBase:   num(l.taxBase)   ?? 0,
      vatRate:   num(l.vatRate)   ?? 0,
      vatAmount: num(l.vatAmount) ?? 0,
    }))
    .filter((l: ExtractedVatLine) => l.vatRate > 0);

  return {
    issuerName:    str(parsed.issuerName),
    issuerCif:     str(parsed.issuerCif)?.replace(/\s/g, "") ?? null,
    receiverName:  str(parsed.receiverName),
    receiverCif:   str(parsed.receiverCif)?.replace(/\s/g, "") ?? null,
    invoiceNumber: str(parsed.invoiceNumber),
    invoiceDate:   str(parsed.invoiceDate),
    taxBase:       num(parsed.taxBase),
    vatRate:       num(parsed.vatRate),
    vatAmount:     num(parsed.vatAmount),
    irpfRate:      num(parsed.irpfRate),
    irpfAmount:    num(parsed.irpfAmount),
    totalAmount:   num(parsed.totalAmount),
    vatLines,
    confidence,
  };
}

/**
 * Nivel 1 — PDF digital: extrae texto con pdfjs y lo procesa con Gemini Flash.
 * Lanza el error "PDF_ESCANEADO" si el texto es insuficiente para señalizar al nivel 2.
 */
export async function extractFromPdfTextWithGemini(base64: string): Promise<OcrResult> {
  const text = await extractPdfText(base64);
  if (text.length < MIN_TEXT_CHARS) {
    throw new Error("PDF_ESCANEADO");
  }

  const extracted = await callGemini([
    { text: `Extrae los campos de esta factura:\n\n${text}` },
  ]);

  return {
    extracted,
    rawText: text,
    rawJson: JSON.stringify({ source: "gemini_text", textLength: text.length }),
  };
}

/**
 * Nivel 2 — PDF escaneado o imagen: envía el documento directamente a Gemini (multimodal).
 */
export async function extractFromDocumentWithGemini(
  base64: string,
  mimeType: string,
): Promise<OcrResult> {
  const extracted = await callGemini([
    { text: "Extrae los campos de esta factura:" },
    { inlineData: { mimeType, data: base64 } },
  ]);

  return {
    extracted,
    rawJson: JSON.stringify({ source: "gemini_multimodal", mimeType }),
  };
}
