import type { OcrResult } from "@/lib/ocr";

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
}

export function ocrReply(): Promise<OcrResult> {
  return reply();
}
