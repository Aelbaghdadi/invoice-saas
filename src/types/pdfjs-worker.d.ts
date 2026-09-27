// pdfjs-dist no publica tipos del worker. Solo se importa para dejarlo en
// globalThis.pdfjsWorker (src/lib/ocrLlm.ts), sin usar lo que exporta.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
