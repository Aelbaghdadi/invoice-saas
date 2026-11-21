import type { OcrResult } from "@/lib/ocr";
import type { PageReading } from "@/lib/pdfSegmentation";

/**
 * OCR simulado (Gemini): nunca se llama a un proveedor real.
 * Por defecto falla, para que un test que lo necesite lo diga. El camino
 * Facturae (XML) no es OCR y va con el parser real.
 */
type Reply = () => Promise<OcrResult>;
const notConfigured: Reply = async () => {
  throw new Error("OCR no simulado en este test: usa stubOcr() o sube la factura en XML");
};
let reply: Reply = notConfigured;

export function stubOcr(next: Reply) {
  reply = next;
}

export function resetOcrStub() {
  reply = notConfigured;
  pagesReply = noPages;
}

/**
 * Clasificacion de paginas de un taco (separacion automatica). Por defecto
 * no hay lectura: el PDF se analiza entero, como antes de la separacion.
 */
type PagesReply = () => Promise<PageReading[] | null>;
const noPages: PagesReply = async () => null;
let pagesReply: PagesReply = noPages;

export function stubPages(next: PagesReply) {
  pagesReply = next;
}

export function pagesReplyFor(): Promise<PageReading[] | null> {
  return pagesReply();
}

export function ocrReply(): Promise<OcrResult> {
  return reply();
}
