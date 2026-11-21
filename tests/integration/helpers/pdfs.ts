/** PDF de prueba para electrónico o papel: con capa de texto o solo con una
 *  imagen, y con el productor que se le pida (como lo deja un escáner). */
import { PDFDocument, StandardFonts } from "pdf-lib";

/** PNG de 1x1: la «foto» de un escaneo. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export async function testPdf(
  opts: { text?: boolean; image?: boolean; producer?: string; pages?: number } = {},
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let n = 0; n < (opts.pages ?? 1); n++) {
    const page = doc.addPage();
    if (opts.text) {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      [
        "FACTURA F-2026-0153",
        "Proveedor SL - NIF B12345674",
        "Cliente Prueba SL - NIF B00000002",
        "Base imponible 100,00 EUR - IVA 21 % 21,00 EUR",
        "Total factura 121,00 EUR - Vencimiento a 30 dias",
      ].forEach((line, i) => page.drawText(line, { x: 50, y: 700 - i * 20, size: 12, font }));
    }
    if (opts.image) {
      const png = await doc.embedPng(PNG_1X1);
      page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
    }
  }
  if (opts.producer) doc.setProducer(opts.producer);
  return Buffer.from(await doc.save());
}

/** Un PDF nacido digital (lo que manda un programa de facturación). */
export const DIGITAL_PRODUCER = "Microsoft Word para Microsoft 365";
/** Un escaneo de una multifunción, con su capa de texto (OCR del escáner). */
export const SCANNER_PRODUCER = "Canon iR-ADV C5535";

export const digitalPdf = () => testPdf({ text: true, producer: DIGITAL_PRODUCER });
export const scannerPdf = () => testPdf({ text: true, image: true, producer: SCANNER_PRODUCER });
export const imageOnlyPdf = () => testPdf({ image: true, producer: "Mi app de fotos" });
