import type { OcrResult, ExtractedInvoice, ExtractedVatLine } from "./ocr";
import type { FieldBoundingBoxes, BoundingBox } from "./boundingBoxes";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

// PDFs con menos de este umbral de caracteres se consideran escaneados
const MIN_TEXT_CHARS = 100;

type PdfTextItem = {
  str: string;
  pageNum: number; // 0-indexed
  x: number;      // normalizado 0-1 desde la izquierda
  y: number;      // normalizado 0-1 desde arriba
  w: number;
  h: number;
};

/**
 * Extrae texto e items con posición de cada página del PDF.
 * La posición está normalizada a 0-1 (y desde arriba, al contrario que PDF space).
 */
async function extractPdfTextAndItems(
  base64: string,
): Promise<{ text: string; items: PdfTextItem[] }> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = "";

    const buffer = Buffer.from(base64, "base64");
    const pdf = await (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer) }).promise;

    let text = "";
    const items: PdfTextItem[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      // viewport a escala 1: convierte coordenadas PDF (origen abajo-izquierda)
      // a viewport (origen arriba-izquierda). Maneja rotaciones y crop boxes.
      const viewport = page.getViewport({ scale: 1 });
      const vw = viewport.width as number;
      const vh = viewport.height as number;

      const content = await page.getTextContent();
      for (const item of content.items as any[]) {
        if (!("str" in item)) continue;
        const s = item.str as string;
        text += s + " ";
        if (!s.trim() || !item.width) continue;

        const tx = item.transform[4] as number;
        const ty = item.transform[5] as number;
        const iw = item.width as number;
        const ih = Math.abs(item.height as number) || Math.abs(item.transform[3] as number) || 8;

        // Convertir esquina superior-izquierda y esquina inferior-derecha del glifo
        const [x1, y1] = viewport.convertToViewportPoint(tx, ty + ih);       // arriba-izq
        const [x2, y2] = viewport.convertToViewportPoint(tx + iw, ty);       // abajo-der

        const left   = Math.min(x1, x2);
        const top    = Math.min(y1, y2);
        const right  = Math.max(x1, x2);
        const bottom = Math.max(y1, y2);

        items.push({
          str: s,
          pageNum: pageNum - 1,
          x: Math.max(0, Math.min(1, left / vw)),
          y: Math.max(0, Math.min(1, top / vh)),
          w: Math.max(0, Math.min(1, (right - left) / vw)),
          h: Math.max(0, Math.min(1, (bottom - top) / vh)),
        });
      }
      text += "\n";
    }
    return { text: text.trim(), items };
  } catch {
    return { text: "", items: [] };
  }
}

// Genera variantes de un valor para buscarlo en el texto del PDF.
// Los números llegan de Gemini como "553.34" pero en el PDF aparecen como "553,34" etc.
function buildSearchCandidates(rawValue: string, field: string): string[] {
  const s = rawValue.trim();
  if (!s) return [];

  const candidates = [s];

  if (["taxBase", "vatAmount", "totalAmount", "vatRate", "irpfRate", "irpfAmount"].includes(field)) {
    const n = parseFloat(s);
    if (!isNaN(n)) {
      const dot2 = n.toFixed(2);
      const com2 = dot2.replace(".", ",");
      const dotN = String(n);
      const comN = dotN.replace(".", ",");
      candidates.push(dot2, com2, dotN, comN);
      candidates.push(dot2 + " €", com2 + " €", dot2 + "€", com2 + "€");
      // Miles con punto: "1.234,56"
      if (n >= 1000) {
        const thousands = com2.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
        candidates.push(thousands);
      }
    }
  }

  if (field === "invoiceDate" && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-");
    const dd = d.padStart(2, "0");
    const mm = m.padStart(2, "0");
    const di = String(parseInt(d));
    const mi = String(parseInt(m));
    const yy = y.slice(2);
    candidates.push(
      `${dd}/${mm}/${y}`, `${dd}/${mm}/${yy}`,
      `${dd}-${mm}-${y}`, `${dd}-${mm}-${yy}`,
      `${dd}.${mm}.${y}`, `${dd}.${mm}.${yy}`,
      `${di}/${mi}/${y}`, `${di}/${mi}/${yy}`,
    );
  }

  return [...new Set(candidates)];
}

function mergedBox(span: PdfTextItem[]): BoundingBox {
  const x    = Math.min(...span.map((it) => it.x));
  const y    = Math.min(...span.map((it) => it.y));
  const xMax = Math.max(...span.map((it) => it.x + it.w));
  const yMax = Math.max(...span.map((it) => it.y + it.h));
  return { page: span[0].pageNum, x, y, width: xMax - x, height: yMax - y };
}

function searchInPdfItems(target: string, items: PdfTextItem[]): BoundingBox | null {
  const n = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const t = n(target);
  if (!t || t.length < 2) return null;

  // 1. Coincidencia exacta con un solo item
  for (const it of items) {
    if (n(it.str) === t) return { page: it.pageNum, x: it.x, y: it.y, width: it.w, height: it.h };
  }

  // 2. El target está contenido en un solo item
  for (const it of items) {
    if (n(it.str).includes(t)) return { page: it.pageNum, x: it.x, y: it.y, width: it.w, height: it.h };
  }

  // 3. Ventana deslizante sobre items consecutivos de la misma página
  for (let i = 0; i < items.length; i++) {
    let concat = "";
    const span: PdfTextItem[] = [];
    for (let j = i; j < Math.min(i + 10, items.length); j++) {
      if (items[j].pageNum !== items[i].pageNum) break;
      concat += (j > i ? " " : "") + items[j].str;
      span.push(items[j]);
      if (n(concat).includes(t)) return mergedBox(span);
    }
  }

  return null;
}

const BBOX_FIELDS = [
  "issuerName", "issuerCif", "receiverName", "receiverCif",
  "invoiceNumber", "invoiceDate", "taxBase", "vatRate", "vatAmount", "totalAmount",
] as const;

/** Localiza en el PDF la posición de cada campo extraído por Gemini. */
function findBboxesInPdf(extracted: ExtractedInvoice, items: PdfTextItem[]): FieldBoundingBoxes {
  const values: Record<string, string | number | null | undefined> = {};
  for (const f of BBOX_FIELDS) {
    const v = extracted[f as keyof ExtractedInvoice];
    if (v == null || typeof v === "string" || typeof v === "number") values[f] = v;
  }
  return findBboxesFromValues(values, items);
}

function findBboxesFromValues(
  values: Record<string, string | number | null | undefined>,
  items: PdfTextItem[],
): FieldBoundingBoxes {
  const result: FieldBoundingBoxes = {};
  for (const [field, val] of Object.entries(values)) {
    if (val == null) continue;
    const candidates = buildSearchCandidates(String(val), field);
    for (const candidate of candidates) {
      const box = searchInPdfItems(candidate, items);
      if (box) { result[field] = box; break; }
    }
  }
  return result;
}

/**
 * Calcula bounding boxes para un PDF (base64) buscando los valores dados en los
 * items de texto de pdfjs. Útil para facturas antiguas sin bboxes almacenadas.
 */
export async function computeBboxesFromPdf(
  base64: string,
  values: Record<string, string | number | null | undefined>,
): Promise<FieldBoundingBoxes> {
  const { items } = await extractPdfTextAndItems(base64);
  return findBboxesFromValues(values, items);
}

// Campos de factura sin coordenadas (para extracción por texto plano).
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

// Igual que EXTRACTION_PROMPT pero añade boundingBoxes: coordenadas del
// texto de cada campo en la imagen, normalizadas 0-1000 (ymin,xmin,ymax,xmax).
// Solo tiene sentido en modo multimodal (imagen o PDF escaneado).
const EXTRACTION_PROMPT_BBOX = `Eres un extractor de facturas españolas. Extrae los campos y devuelve SOLO un JSON válido con esta estructura exacta, sin texto adicional:

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
  },
  "boundingBoxes": {
    "issuerName":    [ymin, xmin, ymax, xmax],
    "issuerCif":     [ymin, xmin, ymax, xmax],
    "receiverName":  [ymin, xmin, ymax, xmax],
    "receiverCif":   [ymin, xmin, ymax, xmax],
    "invoiceNumber": [ymin, xmin, ymax, xmax],
    "invoiceDate":   [ymin, xmin, ymax, xmax],
    "taxBase":       [ymin, xmin, ymax, xmax],
    "vatRate":       [ymin, xmin, ymax, xmax],
    "vatAmount":     [ymin, xmin, ymax, xmax],
    "totalAmount":   [ymin, xmin, ymax, xmax]
  }
}

Reglas:
- vatRate: null si hay múltiples tipos de IVA; incluirlos todos en vatLines
- vatLines: una entrada por tipo de IVA (4%, 10%, 21%, etc.)
- irpfRate/irpfAmount: solo si aparece retención explícita en la factura
- confidence: 0.0-1.0 según tu certeza; 0.0 para campos no encontrados
- invoiceDate: siempre YYYY-MM-DD
- CIFs sin espacios ni guiones
- boundingBoxes: para cada campo, las coordenadas del texto en la imagen como [ymin, xmin, ymax, xmax] con valores enteros de 0 a 1000 (normalizados respecto al alto y ancho de la página). Usa null para un campo si no aparece o no lo localizas visualmente.`;

type GeminiResult = {
  extracted: ExtractedInvoice;
  bboxes: FieldBoundingBoxes;
};

/** Llama a la API de Gemini Flash con las partes del mensaje. */
async function callGemini(
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  prompt: string = EXTRACTION_PROMPT,
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta GEMINI_API_KEY en las variables de entorno");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
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
function parseGeminiResponse(raw: string): GeminiResult {
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

  // Bounding boxes opcionales: [ymin, xmin, ymax, xmax] 0-1000
  const bboxes: FieldBoundingBoxes = {};
  const rawBboxes = parsed.boundingBoxes;
  if (rawBboxes && typeof rawBboxes === "object") {
    for (const field of ALL_FIELDS) {
      const box = rawBboxes[field];
      if (!Array.isArray(box) || box.length < 4) continue;
      const [ymin, xmin, ymax, xmax] = (box as number[]).map((v) => v / 1000);
      const width  = xmax - xmin;
      const height = ymax - ymin;
      if (width > 0 && height > 0) {
        bboxes[field] = { page: 0, x: xmin, y: ymin, width, height };
      }
    }
  }

  return {
    extracted: {
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
    },
    bboxes,
  };
}

/**
 * Extrae los FieldBoundingBoxes del rawResponse guardado por Gemini (texto o multimodal).
 * Formato almacenado: { page, x, y, width, height } ya normalizado a 0-1.
 * Devuelve {} si no hay coordenadas (factura antigua o extracción sin layout).
 */
export function extractGeminiBoundingBoxes(rawJson: string): FieldBoundingBoxes {
  try {
    const data = JSON.parse(rawJson);
    const bboxes = data.boundingBoxes;
    if (!bboxes || typeof bboxes !== "object") return {};
    const result: FieldBoundingBoxes = {};
    for (const [field, box] of Object.entries(bboxes)) {
      if (!box || typeof box !== "object" || Array.isArray(box)) continue;
      const b = box as Record<string, unknown>;
      const x = b.x as number;
      const y = b.y as number;
      const w = b.width as number;
      const h = b.height as number;
      if (typeof x !== "number" || typeof y !== "number" ||
          typeof w !== "number" || typeof h !== "number") continue;
      if (w > 0 && h > 0) {
        result[field] = { page: (b.page as number) ?? 0, x, y, width: w, height: h };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Nivel 1 — PDF digital: extrae texto con pdfjs y lo procesa con Gemini Flash.
 * Lanza el error "PDF_ESCANEADO" si el texto es insuficiente para señalizar al nivel 2.
 * Las bounding boxes se obtienen buscando los valores extraídos en los items de pdfjs,
 * que sí conocen la posición exacta de cada fragmento de texto en la página.
 */
export async function extractFromPdfTextWithGemini(base64: string): Promise<OcrResult> {
  const { text, items } = await extractPdfTextAndItems(base64);
  if (text.length < MIN_TEXT_CHARS) {
    throw new Error("PDF_ESCANEADO");
  }

  const { extracted } = await callGemini([
    { text: `Extrae los campos de esta factura:\n\n${text}` },
  ]);

  const bboxes = findBboxesInPdf(extracted, items);

  return {
    extracted,
    rawText: text,
    rawJson: JSON.stringify({ source: "gemini_text", textLength: text.length, boundingBoxes: bboxes }),
  };
}

/**
 * Nivel 2 — PDF escaneado o imagen: envía el documento directamente a Gemini (multimodal).
 * Solicita bounding boxes por campo para poder resaltarlos en el visor.
 */
export async function extractFromDocumentWithGemini(
  base64: string,
  mimeType: string,
): Promise<OcrResult> {
  const { extracted, bboxes } = await callGemini(
    [
      { text: "Extrae los campos de esta factura:" },
      { inlineData: { mimeType, data: base64 } },
    ],
    EXTRACTION_PROMPT_BBOX,
  );

  return {
    extracted,
    rawJson: JSON.stringify({ source: "gemini_multimodal", mimeType, boundingBoxes: bboxes }),
  };
}
