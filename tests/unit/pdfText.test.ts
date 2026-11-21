// F-013: el texto de los PDF digitales se extrae en el servidor. Antes
// GlobalWorkerOptions.workerSrc = "" rompia pdfjs en Node y todos salian con
// texto vacio, como escaneados.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfTextAndItems, pdfReadingForMedium } from "@/lib/ocrLlm";
import { pdfTextLayerStats, proposeOriginalMedium } from "@/lib/originalMedium";

const pdf = (path: string) => readFileSync(path).toString("base64");

/** PNG de 1x1 (la «foto» de un escaneo dentro del PDF). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** PDF hecho con pdf-lib: con texto o solo con una imagen, y con el productor que se le pida. */
async function makePdf(opts: { text?: boolean; image?: boolean; producer?: string; creator?: string }): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  if (opts.text) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = [
      "FACTURA F-2026-0153",
      "Proveedor SL - NIF B12345674",
      "Cliente Prueba SL - NIF B00000002",
      "Base imponible 100,00 EUR - IVA 21 % 21,00 EUR",
      "Total factura 121,00 EUR - Vencimiento a 30 dias",
    ];
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 700 - i * 20, size: 12, font }));
  }
  if (opts.image) {
    const png = await doc.embedPng(PNG_1X1);
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  }
  if (opts.producer) doc.setProducer(opts.producer);
  if (opts.creator) doc.setCreator(opts.creator);
  return Buffer.from(await doc.save()).toString("base64");
}

describe("extractPdfTextAndItems (F-013)", () => {
  it("lee el texto y las posiciones de los PDF de la demo", async () => {
    const { text, items } = await extractPdfTextAndItems(pdf("scripts/demo-pdfs/amazon-oficina.pdf"));
    expect(text.length).toBeGreaterThan(100); // MIN_TEXT_CHARS: no es un escaneado
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeLessThanOrEqual(1);
    }
  });

  it("una rectificativa: sale el CIF y el número impresos", async () => {
    const { text } = await extractPdfTextAndItems(pdf("scripts/demo-pdfs/rectificativas/4-multi-iva-mixto.pdf"));
    expect(text).toContain("A12345674");
    expect(text).toContain("SM-2026-0142-R");
  });

  it("lo que no es un PDF: texto vacío, sin lanzar", async () => {
    const { text, items } = await extractPdfTextAndItems(Buffer.from("no es un pdf").toString("base64"));
    expect([text, items]).toEqual(["", []]);
  });
});

describe("extractPdfTextAndItems: productor y lectura fallida (electrónico o papel)", () => {
  it("los PDF de la demo dicen su productor y su creador, y salen electrónicos", async () => {
    for (const file of ["scripts/seed-pdfs/telefonica-abril.pdf", "scripts/seed-pdfs/repsol-gasoil.pdf", "scripts/demo-pdfs/amazon-oficina.pdf"]) {
      const read = await extractPdfTextAndItems(pdf(file));
      expect(read.info, file).toEqual({ producer: "ReportLab PDF Library - (opensource)", creator: "(unspecified)" });
      expect(read.failed, file).toBeUndefined();
      expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) }), file).toEqual({
        medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text", pdfProducer: "ReportLab PDF Library - (opensource)",
      });
    }
  });

  it("un PDF de pdf-lib con el productor de un escáner Canon: escaneo aunque traiga texto", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ text: true, producer: "Canon iR-ADV C5535" }));
    expect(read.info.producer).toBe("Canon iR-ADV C5535");
    expect(pdfTextLayerStats(read.text).chars).toBeGreaterThan(100);
    expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) })).toEqual({
      medium: null, source: "AUTO", reason: "scan_unconfirmed", pdfProducer: "Canon iR-ADV C5535",
    });
  });

  it("el mismo PDF con el productor de un programa sale electrónico", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ text: true, producer: "Microsoft® Word para Microsoft 365" }));
    expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) })).toMatchObject({
      medium: "ELECTRONIC", reason: "pdf_text",
    });
  });

  it("productor y creador recortados a 200 caracteres y sin espacios en los bordes", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ text: true, producer: `  ${"x".repeat(300)}  `, creator: " Writer " }));
    expect(read.info).toEqual({ producer: "x".repeat(200), creator: "Writer" });
  });

  it("un NUL u otro carácter de control en el productor o el creador se quita: Postgres no admite NUL en un texto", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ text: true, producer: "Microsoft Word\u0000", creator: "Acme\u0000PDF\u0007" }));
    expect(read.info).toEqual({ producer: "Microsoft Word", creator: "Acme PDF" });
  });

  it("un PDF que solo lleva una imagen tiene 0 caracteres: escaneo", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ image: true }));
    expect(read.failed).toBeUndefined();
    expect(pdfTextLayerStats(read.text).chars).toBe(0);
    expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) })).toMatchObject({
      medium: null, reason: "scan_unconfirmed",
    });
  });

  it("lo que no es un PDF: failed, sin productor, y no se ha podido leer", async () => {
    const read = await extractPdfTextAndItems(Buffer.from("no es un pdf").toString("base64"));
    expect(read).toMatchObject({ failed: true, info: { producer: null, creator: null } });
    expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) })).toMatchObject({
      medium: null, reason: "pdf_unreadable",
    });
  });

  it("cortado por tiempo: sin texto, pero con el productor ya leído", async () => {
    const read = await extractPdfTextAndItems(await makePdf({ text: true, producer: "Mi programa" }), -1);
    expect(read).toMatchObject({ text: "", timedOut: true, info: { producer: "Mi programa" } });
    expect(proposeOriginalMedium({ fileType: "application/pdf", pdf: pdfReadingForMedium(read) }).reason).toBe("pdf_unreadable");
  });
});
