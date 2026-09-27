import type { OcrResult, ExtractedInvoice, ExtractedVatLine } from "./ocr";
import type { FieldBoundingBoxes, BoundingBox } from "./boundingBoxes";
import { normalizeCurrency } from "./currency";
import { normalizeGoodsType } from "./intracomGoods";
import { isValidNIF } from "./validators";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";

// PDFs con menos de este umbral de caracteres (sin espacios) se consideran escaneados
const MIN_TEXT_CHARS = 100;

/** Candidatos a NIF, CIF o NIE, ya con la letra pegada; se validan con
 *  isValidNIF (digito de control). */
const SPANISH_TAX_ID_RE = /\b(?:[A-HJ-NP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g;
/** VAT de la UE, Reino Unido e Irlanda del Norte (GB, XI) y Suiza (CHE), con
 *  una lista cerrada de prefijos: con «dos letras y 8-12 caracteres»
 *  contaban como VAT «PEDIDO12345678» o «REGISTRO2026». */
const VAT_RE =
  /\b(?:(?:AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|GB|XI)[A-Z0-9]{0,2}\d{7,12}(?:[A-Z]\d{2}|[A-Z0-9])?|CHE[-.\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3})\b/;
/** Un importe con dos decimales (121,00 / 1.234,56 / 1,234.56 / -21.00):
 *  la parte entera es un numero o miles bien agrupados, y no va pegado a
 *  otro numero. «14.09» de «14.09.2026», «10.32.15» o un telefono
 *  «91.123.45.67» contaban como importes. */
const AMOUNT_RE = /(?<![\d.,:/])-?(?:\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+|\d+)[.,]\d{2}(?![.,:/]?\d)/;
/** Caracteres que salen de una capa de texto rota: U+FFFD y uso privado. */
const BROKEN_CHAR_RE = /[\uFFFD\uE000-\uF8FF]/g;

/** ¿Trae el texto un NIF, CIF o NIE valido, o un VAT? */
export function textHasTaxId(text: string): boolean {
  const upper = text.toUpperCase();
  // Solo se pega el prefijo de una letra a sus 7 digitos («B-12345674»,
  // «B 12345674»), no cualquier palabra seguida de un numero.
  const joined = upper.replace(/\b([A-Z])[-.\s]?(?=\d{7})/g, "$1");
  for (const candidate of joined.match(SPANISH_TAX_ID_RE) ?? []) {
    if (isValidNIF(candidate)) return true;
  }
  return VAT_RE.test(upper);
}

/**
 * ¿Vale el texto de un PDF para mandarlo a Gemini en vez de la imagen?
 * Solo la longitud no basta (revision 1 del PR #9): un escaneado con un
 * sello de registro en texto, una capa OCR mala («T0TAL 217,8O») o una
 * cabecera en texto con el cuadro de importes como imagen iban por texto y
 * Gemini no veia los importes. Exige texto de verdad, un importe y un NIF.
 */
export function isUsefulPdfText(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= MIN_TEXT_CHARS) return false;
  const broken = compact.match(BROKEN_CHAR_RE)?.length ?? 0;
  if (broken / compact.length > 0.02) return false;
  if (!AMOUNT_RE.test(text)) return false;
  return textHasTaxId(text);
}

/** Error de la via de texto que manda el PDF a la multimodal: no hay texto util. */
export const PDF_ESCANEADO = "PDF_ESCANEADO";

type PdfTextItem = {
  str: string;
  pageNum: number; // 0-indexed
  x: number;      // normalizado 0-1 desde la izquierda
  y: number;      // normalizado 0-1 desde arriba
  w: number;
  h: number;
};

/**
 * Extrae texto e items con posición de cada página del PDF. Exportada para
 * los tests.
 * La posición está normalizada a 0-1 (y desde arriba, al contrario que PDF space).
 */
/** Paginas que se leen: las primeras y la ultima. Una factura rara vez pasa
 *  de ahi, y pdfjs en Node no cede el event loop (su «fake worker» corre en
 *  el hilo principal): 500 paginas lo bloqueaban unos 3 s. */
const MAX_FIRST_PAGES = 5;
/** Tiempo maximo leyendo texto; si se pasa, el PDF va por la imagen. */
const TEXT_BUDGET_MS = 2_000;
/** Texto maximo que se manda a Gemini (antes, hasta 1,9 M caracteres): el
 *  principio y el final, que es donde suelen ir los totales. */
const GEMINI_TEXT_HEAD = 30_000;
const GEMINI_TEXT_TAIL = 10_000;

/** El texto para Gemini: entero si cabe; si no, cabeza y cola con una marca.
 *  Con slice(0, 40000) se perdia la ultima pagina, la de los totales. */
export function textForGemini(text: string): string {
  if (text.length <= GEMINI_TEXT_HEAD + GEMINI_TEXT_TAIL) return text;
  return `${text.slice(0, GEMINI_TEXT_HEAD)}\n[… texto recortado …]\n${text.slice(-GEMINI_TEXT_TAIL)}`;
}
/** Texto que se guarda en el JSON crudo de la extraccion. */
const RAW_TEXT_EXCERPT = 4_000;

/** Las paginas que se leen, de 1 a numPages. */
export function pagesToRead(numPages: number): number[] {
  const pages = Array.from({ length: Math.min(numPages, MAX_FIRST_PAGES) }, (_, i) => i + 1);
  if (numPages > MAX_FIRST_PAGES) pages.push(numPages);
  return pages;
}

export async function extractPdfTextAndItems(
  base64: string,
  budgetMs: number = TEXT_BUDGET_MS,
): Promise<{ text: string; items: PdfTextItem[]; timedOut?: boolean }> {
  // Se destruye siempre, tambien si falla o se pasa del tiempo: libera el
  // documento y el worker de ese PDF.
  let loadingTask: { promise: Promise<any>; destroy(): Promise<void> } | null = null;
  try {
    // En Node pdfjs usa un «fake worker» que carga pdf.worker.mjs. Antes se
    // ponia GlobalWorkerOptions.workerSrc = "", que pisa su valor por defecto:
    // getDocument lanzaba, el catch devolvia texto vacio y todo PDF digital
    // se trataba como escaneado (F-013). Con el worker cargado en
    // globalThis.pdfjsWorker no hace falta workerSrc, y Next lo empaqueta.
    const globals = globalThis as { pdfjsWorker?: unknown };
    globals.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    const buffer = Buffer.from(base64, "base64");
    // verbosity 0: solo errores. Sin las fuentes estandar (standardFontDataUrl)
    // avisa en cada PDF, y para sacar el texto no hacen falta.
    loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
    const pdf = await loadingTask!.promise;

    let text = "";
    const items: PdfTextItem[] = [];
    const startedAt = Date.now();

    for (const pageNum of pagesToRead(pdf.numPages)) {
      if (Date.now() - startedAt > budgetMs) return { text: "", items: [], timedOut: true };
      // Las paginas que no se leen se marcan, para que Gemini devuelva null
      // en lo que no ve en vez de inventarlo.
      if (pageNum === pdf.numPages && pdf.numPages > MAX_FIRST_PAGES + 1) {
        text += `[… páginas ${MAX_FIRST_PAGES + 1} a ${pdf.numPages - 1} omitidas …]\n`;
      }
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
  } catch (err) {
    // Sin texto el PDF va por la via multimodal como si fuera escaneado: que
    // quede en el log, antes fallaba siempre sin que nadie lo viera.
    console.error("extractPdfTextAndItems: no se pudo leer el texto del PDF", err);
    return { text: "", items: [] };
  } finally {
    await loadingTask?.destroy().catch(() => {});
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
      // Primero el formato español: es el que casi siempre aparece.
      if (n >= 1000) candidates.push(com2.replace(/\B(?=(\d{3})+(?!\d))/g, ".")); // "1.234,56"
      candidates.push(com2, comN, com2 + " €", com2 + "€");
      candidates.push(dot2, dotN, dot2 + " €", dot2 + "€");
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

/** Un item con su texto ya normalizado: se normaliza una vez por PDF, no una
 *  vez por candidato (con 2.754 items tardaba unos 2 s). */
type SearchItem = { item: PdfTextItem; norm: string };
const normalizeForSearch = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function searchInPdfItems(target: string, items: SearchItem[]): BoundingBox | null {
  const t = normalizeForSearch(target);
  if (!t || t.length < 2) return null;
  const box = (it: PdfTextItem): BoundingBox => ({ page: it.pageNum, x: it.x, y: it.y, width: it.w, height: it.h });

  // 1. Coincidencia exacta con un solo item
  for (const { item, norm } of items) {
    if (norm === t) return box(item);
  }

  // 2. El target está contenido en un solo item
  for (const { item, norm } of items) {
    if (norm.indexOf(t) !== -1) return box(item);
  }

  // 3. Ventana deslizante sobre items consecutivos de la misma página
  for (let i = 0; i < items.length; i++) {
    let concat = "";
    const span: PdfTextItem[] = [];
    for (let j = i; j < Math.min(i + 10, items.length); j++) {
      if (items[j].item.pageNum !== items[i].item.pageNum) break;
      if (items[j].norm) concat += (concat ? " " : "") + items[j].norm;
      span.push(items[j].item);
      if (concat.indexOf(t) !== -1) return mergedBox(span);
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
  const searchItems = items.map((item) => ({ item, norm: normalizeForSearch(item.str) }));
  for (const [field, val] of Object.entries(values)) {
    if (val == null) continue;
    const candidates = buildSearchCandidates(String(val), field);
    for (const candidate of candidates) {
      const box = searchInPdfItems(candidate, searchItems);
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
  "currency": "Código ISO 4217 de la moneda de los importes (EUR, USD, GBP...) o null",
  "supplyType": "BIENES, SERVICIOS o null",
  "vatLines": [
    {
      "taxBase": 0.00, "vatRate": 21, "vatAmount": 0.00,
      "equivalenceSurchargeRate": null, "equivalenceSurchargeAmount": null
    }
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
- currency: código ISO de 3 letras solo si la factura muestra la moneda (símbolo o código); null si no aparece
- equivalenceSurchargeRate/equivalenceSurchargeAmount de cada línea de vatLines: SOLO si el documento muestra el recargo de equivalencia con su % y/o cuota PARA ESE TIPO DE IVA; null en caso contrario. Aparece con muchos nombres: "Recargo de Equivalencia", "Rec. Equiv.", "R.E.", "RE 5,2%", "REC 5,2%", o como una fila/columna más del cuadro de impuestos con el 5,2 / 1,4 / 0,5. NUNCA los derives del % de IVA. El recargo puede ir en unas líneas y no en otras de la misma factura (p.ej. portes sin recargo).
- El recargo NO es una línea de vatLines: va en los campos de recargo de la línea del IVA al que acompaña (5,2 con el 21%, 1,4 con el 10%, 0,5 con el 4%). No crees NUNCA una entrada de vatLines con vatRate 5,2 / 1,4 / 0,5 aunque en la factura aparezca como una fila más.
- supplyType: qué se factura según los conceptos. "BIENES" si son productos o mercancías que se entregan (aunque se cobren portes aparte); "SERVICIOS" si es un servicio (software, suscripciones, licencias, publicidad, marketing, consultoría, comisiones, formación, alojamiento, reparaciones, transporte o logística facturados solos...). Si hay de las dos cosas, la de mayor importe. null si no se puede saber.
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
  "currency": "Código ISO 4217 de la moneda de los importes (EUR, USD, GBP...) o null",
  "supplyType": "BIENES, SERVICIOS o null",
  "vatLines": [
    {
      "taxBase": 0.00, "vatRate": 21, "vatAmount": 0.00,
      "equivalenceSurchargeRate": null, "equivalenceSurchargeAmount": null
    }
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
- currency: código ISO de 3 letras solo si la factura muestra la moneda (símbolo o código); null si no aparece
- equivalenceSurchargeRate/equivalenceSurchargeAmount de cada línea de vatLines: SOLO si el documento muestra el recargo de equivalencia con su % y/o cuota PARA ESE TIPO DE IVA; null en caso contrario. Aparece con muchos nombres: "Recargo de Equivalencia", "Rec. Equiv.", "R.E.", "RE 5,2%", "REC 5,2%", o como una fila/columna más del cuadro de impuestos con el 5,2 / 1,4 / 0,5. NUNCA los derives del % de IVA. El recargo puede ir en unas líneas y no en otras de la misma factura (p.ej. portes sin recargo).
- El recargo NO es una línea de vatLines: va en los campos de recargo de la línea del IVA al que acompaña (5,2 con el 21%, 1,4 con el 10%, 0,5 con el 4%). No crees NUNCA una entrada de vatLines con vatRate 5,2 / 1,4 / 0,5 aunque en la factura aparezca como una fila más.
- supplyType: qué se factura según los conceptos. "BIENES" si son productos o mercancías que se entregan (aunque se cobren portes aparte); "SERVICIOS" si es un servicio (software, suscripciones, licencias, publicidad, marketing, consultoría, comisiones, formación, alojamiento, reparaciones, transporte o logística facturados solos...). Si hay de las dos cosas, la de mayor importe. null si no se puede saber.
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
      equivalenceSurchargeRate:   num(l.equivalenceSurchargeRate),
      equivalenceSurchargeAmount: num(l.equivalenceSurchargeAmount),
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
      currency:      normalizeCurrency(parsed.currency),
      supplyType: normalizeGoodsType(parsed.supplyType),
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

/** ¿Falta el total? La plantilla del prompt trae «"totalAmount": 0.00», asi
 *  que un 0 con confianza 0 es «no lo he encontrado». Un 0 con confianza es
 *  un total a cero de verdad (una rectificativa que anula a otra). */
function totalMissing(extracted: ExtractedInvoice): boolean {
  return extracted.totalAmount == null || (extracted.totalAmount === 0 && extracted.confidence?.totalAmount === 0);
}

/** ¿Ha salido lo basico: el total y el CIF del emisor? */
function hasBasics(extracted: ExtractedInvoice): boolean {
  const allKeyFieldsNull = [extracted.issuerName, extracted.issuerCif, extracted.invoiceNumber, extracted.totalAmount]
    .every((v) => v == null);
  return !(totalMissing(extracted) || extracted.issuerCif == null || allKeyFieldsNull);
}

/**
 * Nivel 1 — PDF digital: extrae texto con pdfjs y lo procesa con Gemini Flash.
 * Lanza PDF_ESCANEADO si el texto no vale (isUsefulPdfText). Si Gemini no
 * saca lo basico, devuelve el resultado con complete: false: no se tira,
 * por si la imagen tambien falla.
 * Las bounding boxes se obtienen buscando los valores extraídos en los items de pdfjs,
 * que sí conocen la posición exacta de cada fragmento de texto en la página.
 */
export async function extractFromPdfTextWithGemini(base64: string): Promise<{ result: OcrResult; complete: boolean }> {
  const { text, items, timedOut } = await extractPdfTextAndItems(base64);
  if (timedOut) console.warn("extractFromPdfTextWithGemini: el texto tardaba demasiado, va por la imagen");
  if (!isUsefulPdfText(text)) {
    throw new Error(PDF_ESCANEADO);
  }

  const { extracted } = await callGemini([
    { text: `Extrae los campos de esta factura:\n\n${textForGemini(text)}` },
  ]);
  const bboxes = findBboxesInPdf(extracted, items);

  return {
    complete: hasBasics(extracted),
    result: {
      extracted,
      rawText: text,
      // Un trozo del texto en el JSON crudo (InvoiceExtraction.rawResponse),
      // sin migracion: para comparar la via de texto con la de imagen.
      rawJson: JSON.stringify({
        source: "gemini_text", textLength: text.length, textExcerpt: text.slice(0, RAW_TEXT_EXCERPT), boundingBoxes: bboxes,
      }),
    },
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

/**
 * PDF con Gemini: primero por texto; si el PDF es escaneado, su texto no
 * vale o con el texto no sale lo basico, por la imagen. Devuelve la via que
 * se usa de verdad (InvoiceExtraction.source).
 *
 * El resultado del texto no se tira: si la imagen falla (un 400 por tamaño,
 * un 5xx) o tampoco saca el total, se devuelve el del texto, con datos
 * parciales para revisar en vez de Error OCR. Si se usa la imagen, se
 * conserva el texto del PDF (rawText) para las heuristicas.
 */
export async function extractPdfWithGemini(base64: string): Promise<{ source: "gemini_text" | "gemini_multimodal"; result: OcrResult }> {
  let fromText: { result: OcrResult; complete: boolean } | null = null;
  try {
    fromText = await extractFromPdfTextWithGemini(base64);
  } catch (e) {
    if (!(e instanceof Error && e.message === PDF_ESCANEADO)) throw e;
  }
  if (fromText?.complete) return { source: "gemini_text", result: fromText.result };

  if (!fromText) {
    return { source: "gemini_multimodal", result: await extractFromDocumentWithGemini(base64, "application/pdf") };
  }
  try {
    const image = await extractFromDocumentWithGemini(base64, "application/pdf");
    if (totalMissing(image.extracted)) return { source: "gemini_text", result: fromText.result };
    return { source: "gemini_multimodal", result: { ...image, rawText: fromText.result.rawText } };
  } catch (e) {
    console.warn("extractPdfWithGemini: la imagen fallo; se usa lo que salio del texto", e);
    return { source: "gemini_text", result: fromText.result };
  }
}
