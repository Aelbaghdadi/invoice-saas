import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  MEDIUM_LABELS,
  MEDIUM_REASON_LABELS,
  MEDIUM_SOURCE_LABELS,
  ORIGINAL_MEDIUM_REASONS,
  PDF_PRODUCER_MAX_LENGTH,
  RETENTION_HOLD_LABELS,
  canAutoUpdateMediumFamily,
  canConfirmMedium,
  hasPdfTextLayer,
  isScannerProducer,
  mediumLabel,
  mediumReasonLabel,
  pdfTextLayerStats,
  proposeOriginalMedium,
  splitPartReasonLabel,
  type MediumProposal,
} from "@/lib/originalMedium";
import { extractPdfTextAndItems, isUsefulPdfText } from "@/lib/ocrLlm";

const PDF = "application/pdf";
const WORD_TEXT =
  "FACTURA Nº F-2026-0042 · Proveedor Ejemplo SL · Calle Mayor 1, 28013 Madrid · " +
  "Cliente Ejemplo SA · Gran Via 2 · CIF B12345674 · Base imponible 100,00 · IVA 21 % 21,00 · Total 121,00";

const pdf = (text: string, more: Partial<{ producer: string | null; creator: string | null; failed: boolean; timedOut: boolean }> = {}) =>
  proposeOriginalMedium({ fileType: PDF, pdf: { text, ...more } });

const unconfirmed = (reason: MediumProposal["reason"]) =>
  expect.objectContaining({ medium: null, source: "AUTO", reason });

describe("proposeOriginalMedium", () => {
  it("un XML es el original electrónico", () => {
    expect(proposeOriginalMedium({ fileType: "application/xml" })).toEqual({
      medium: "ELECTRONIC", source: "AUTO", reason: "xml", pdfProducer: null,
    });
    expect(proposeOriginalMedium({ fileType: "text/xml" }).reason).toBe("xml");
  });

  it("una imagen fuera de un taco queda por confirmar", () => {
    for (const fileType of ["image/jpeg", "image/png", "image/heic"]) {
      expect(proposeOriginalMedium({ fileType }), fileType).toEqual({
        medium: null, source: "AUTO", reason: "image_unconfirmed", pdfProducer: null,
      });
    }
  });

  it("un PDF de Word con texto es electrónico y guarda su productor", () => {
    expect(pdf(WORD_TEXT, { producer: "Microsoft® Word para Microsoft 365", creator: "Microsoft® Word" })).toEqual({
      medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text", pdfProducer: "Microsoft® Word para Microsoft 365",
    });
  });

  it("el productor que se guarda va sin NUL ni otros caracteres de control (Postgres no admite NUL)", () => {
    expect(pdf(WORD_TEXT, { producer: "Microsoft Word\u0000" }).pdfProducer).toBe("Microsoft Word");
    expect(pdf(WORD_TEXT, { producer: "\u0000\u0001", creator: "Writer\u0000" }).pdfProducer).toBe("Writer");
    expect(pdf(WORD_TEXT, { producer: "Canon\u0000iR-ADV C5535" })).toEqual({
      medium: null, source: "AUTO", reason: "scan_unconfirmed", pdfProducer: "Canon iR-ADV C5535",
    });
  });

  it("un PDF digital sin NIF ni importes también es electrónico: basta la capa de texto", () => {
    const text =
      "Albarán de entrega · Pedido 4471 · Referencias: tornillería variada, arandelas y tuercas de acero " +
      "inoxidable · Entregado en el almacén de la calle Mayor";
    expect(pdfTextLayerStats(text).chars).toBeGreaterThan(100);
    expect(isUsefulPdfText(text)).toBe(false);
    expect(pdf(text)).toEqual(expect.objectContaining({ medium: "ELECTRONIC", reason: "pdf_text" }));
  });

  it("un PDF sin texto queda por confirmar como escaneo", () => {
    expect(pdf("")).toEqual(unconfirmed("scan_unconfirmed"));
  });

  it("un PDF con solo un sello corto de texto es un escaneo", () => {
    expect(pdf("REGISTRO DE ENTRADA 14/09/2026 Nº 1234 · Ayuntamiento")).toEqual(unconfirmed("scan_unconfirmed"));
  });

  it("con más de un 2 % de caracteres rotos no hay capa de texto", () => {
    const text = `${"a".repeat(194)}${"\uFFFD".repeat(6)}`;
    expect(pdfTextLayerStats(text)).toEqual({ chars: 200, brokenRatio: 0.03 });
    expect(pdf(text)).toEqual(unconfirmed("scan_unconfirmed"));
  });

  it("un escáner con OCR trae texto, pero su productor lo delata", () => {
    const scanners = [
      "Canon iR-ADV C5535",
      "RICOH IM C3000",
      "ScanSnap Manager #iX1600",
      "PaperStream Capture",
      "ABBYY FineReader PDF 16",
      "Adobe Scan for Android 23.10",
      "CamScanner",
      "Microsoft Lens",
      "NAPS2",
    ];
    for (const producer of scanners) {
      expect(isScannerProducer(producer), producer).toBe(true);
      expect(pdf(WORD_TEXT, { producer }), producer).toEqual({
        medium: null, source: "AUTO", reason: "scan_unconfirmed", pdfProducer: producer,
      });
    }
  });

  it("el escáner puede ir en Creator: se guarda ese", () => {
    const proposal = pdf(WORD_TEXT, { producer: "Adobe PDF Library 17.11", creator: "Canon iR C3025 PDF" });
    expect(proposal).toEqual({ medium: null, source: "AUTO", reason: "scan_unconfirmed", pdfProducer: "Canon iR C3025 PDF" });
  });

  it("los programas que hacen PDF digitales no son escáneres", () => {
    const digital = [
      "Microsoft® Word para Microsoft 365",
      "LibreOffice 7.6",
      "Adobe PDF Library 17.11.238",
      "Acrobat Distiller 23.0 (Windows)",
      "Skia/PDF m120",
      "macOS Versión 14.1 (Compilación 23B74) Quartz PDFContext",
      "iText® 7.2.5 ©2000-2023 iText Group NV",
      "TCPDF 6.6.2 (http://www.tcpdf.org)",
      "PDFsharp 1.50.5147 (www.pdfsharp.com)",
      "pdf-lib (https://github.com/Hopding/pdf-lib)",
      "Kofax Power PDF",
    ];
    for (const producer of digital) expect(isScannerProducer(producer), producer).toBe(false);
    expect(isScannerProducer(null)).toBe(false);
    expect(isScannerProducer("")).toBe(false);
  });

  it("si la lectura falla o se corta, queda por confirmar: no se pudo leer", () => {
    expect(pdf("", { timedOut: true })).toEqual(unconfirmed("pdf_unreadable"));
    expect(pdf("", { failed: true })).toEqual(unconfirmed("pdf_unreadable"));
    expect(proposeOriginalMedium({ fileType: PDF })).toEqual(unconfirmed("pdf_unreadable"));
    // Si el productor ya dice que es un escáner, eso dice más.
    expect(pdf("", { timedOut: true, producer: "RICOH MP C3004" })).toEqual(unconfirmed("scan_unconfirmed"));
  });

  it("con un original en otro formato adjunto es electrónico, puesto a mano", () => {
    expect(proposeOriginalMedium({ fileType: PDF, hasOtherFormatOriginal: true, pdf: { text: "" } })).toEqual({
      medium: "ELECTRONIC", source: "MANUAL", reason: "other_format", pdfProducer: null,
    });
  });

  it("en un taco es papel, aunque el escáner haya puesto texto", () => {
    expect(proposeOriginalMedium({ fileType: PDF, inTaco: true, pdf: { text: WORD_TEXT, producer: "RICOH IM C3000" } })).toEqual({
      medium: "PAPER", source: "TACO", reason: "taco", pdfProducer: "RICOH IM C3000",
    });
    expect(proposeOriginalMedium({ fileType: "image/jpeg", inTaco: true })).toEqual({
      medium: "PAPER", source: "TACO", reason: "taco", pdfProducer: null,
    });
  });

  it("el XML manda sobre todo lo demás", () => {
    expect(proposeOriginalMedium({ fileType: "application/xml", inTaco: true, hasOtherFormatOriginal: true }).reason).toBe("xml");
  });

  it("el productor se guarda recortado", () => {
    const long = `Generador ${"x".repeat(400)}`;
    expect(pdf(WORD_TEXT, { producer: `  ${long}  ` }).pdfProducer).toBe(long.slice(0, PDF_PRODUCER_MAX_LENGTH));
  });

  it("un PDF real de la demo tiene capa de texto", async () => {
    const base64 = readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64");
    const { text } = await extractPdfTextAndItems(base64);
    expect(hasPdfTextLayer(pdfTextLayerStats(text))).toBe(true);
    expect(pdf(text).medium).toBe("ELECTRONIC");
  });
});

describe("capa de texto: los mismos umbrales que isUsefulPdfText", () => {
  // Con NIF e importe, isUsefulPdfText solo depende del largo y de los caracteres rotos.
  const withTaxId = "CIF B12345674 Total 121,00";
  const ofLength = (chars: number, broken = 0) => {
    const filler = chars - broken - withTaxId.replace(/\s+/g, "").length;
    return `${withTaxId} ${"x".repeat(filler)}${"\uFFFD".repeat(broken)}`;
  };

  it("100 caracteres sin espacios no bastan; 101, sí", () => {
    for (const [chars, expected] of [[100, false], [101, true]] as const) {
      const text = ofLength(chars);
      expect(pdfTextLayerStats(text).chars).toBe(chars);
      expect(hasPdfTextLayer(pdfTextLayerStats(text)), `${chars}`).toBe(expected);
      expect(isUsefulPdfText(text), `${chars}`).toBe(expected);
    }
  });

  it("un 2 % de caracteres rotos se admite; más, no", () => {
    for (const [broken, expected] of [[3, true], [4, false]] as const) {
      const text = ofLength(150, broken);
      expect(hasPdfTextLayer(pdfTextLayerStats(text)), `${broken}`).toBe(expected);
      expect(isUsefulPdfText(text), `${broken}`).toBe(expected);
    }
  });
});

// Lo que el análisis escribe en una factura (vacío o AUTO, nunca en una parte)
// lo prueban tests/integration/archiveMedium.test.ts y archiveMediumBackfill.test.ts
// contra el WHERE de writeAutoMedium, que es donde está la regla.
describe("quién manda (R11)", () => {
  it("la raíz propaga a sus partes solo si toda la familia está vacía o en automático", () => {
    expect(canAutoUpdateMediumFamily([{ originalMediumSource: "AUTO" }, { originalMediumSource: null }])).toBe(true);
    expect(canAutoUpdateMediumFamily([{ originalMediumSource: "AUTO" }, { originalMediumSource: "MANUAL" }])).toBe(false);
    expect(canAutoUpdateMediumFamily([{ originalMediumSource: "TACO" }])).toBe(false);
  });

  it("«Confirmar» solo un medio que propuso la app: Electrónico o Papel y que no sea ya a mano", () => {
    expect(canConfirmMedium("ELECTRONIC", "AUTO")).toBe(true);
    expect(canConfirmMedium("PAPER", "TACO")).toBe(true);
    expect(canConfirmMedium("PAPER", null)).toBe(true);
    expect(canConfirmMedium("ELECTRONIC", "MANUAL")).toBe(false);
    // «Por confirmar» no se confirma: se elige Electrónico o Papel.
    expect(canConfirmMedium(null, "AUTO")).toBe(false);
  });
});

describe("etiquetas", () => {
  it("una parte que va igual que el documento dividido dice el motivo de la raíz", () => {
    expect(splitPartReasonLabel("split", "image_unconfirmed")).toBe("Foto: falta confirmar si hay papel (todo el documento dividido)");
    expect(splitPartReasonLabel("split", "scan_unconfirmed")).toBe("Escaneo: falta confirmar si hay papel (todo el documento dividido)");
    // Sin el de la raíz (o uno que no se conoce), el suyo.
    expect(splitPartReasonLabel("split", null)).toBe("Igual que el documento dividido del que sale");
    expect(splitPartReasonLabel("split", "otra-cosa")).toBe("Igual que el documento dividido del que sale");
    // Con su propio motivo, el suyo.
    expect(splitPartReasonLabel("manual", "image_unconfirmed")).toBe("Puesto a mano");
    expect(splitPartReasonLabel(null, "image_unconfirmed")).toBeNull();
  });

  it("el medio vacío se llama «Por confirmar»", () => {
    expect(mediumLabel("ELECTRONIC")).toBe("Electrónico");
    expect(mediumLabel("PAPER")).toBe("Papel");
    expect(mediumLabel(null)).toBe("Por confirmar");
    expect(MEDIUM_LABELS.UNCONFIRMED).toBe("Por confirmar");
  });

  it("los motivos de «Por confirmar» dicen qué falta", () => {
    expect(MEDIUM_REASON_LABELS.scan_unconfirmed).toBe("Escaneo: falta confirmar si hay papel");
    expect(MEDIUM_REASON_LABELS.image_unconfirmed).toBe("Foto: falta confirmar si hay papel");
    expect(MEDIUM_REASON_LABELS.pdf_unreadable).toBe("No se pudo leer el PDF");
    expect(MEDIUM_REASON_LABELS.backfill_pending).toBe("Pendiente de detectar");
  });

  it("todos los motivos tienen etiqueta, y uno desconocido no rompe", () => {
    for (const reason of ORIGINAL_MEDIUM_REASONS) expect(mediumReasonLabel(reason), reason).toBeTruthy();
    expect(mediumReasonLabel("pdf_no_text")).toBeNull();
    expect(mediumReasonLabel(null)).toBeNull();
  });

  it("origen y motivos de «Conservar más», con tildes", () => {
    expect(MEDIUM_SOURCE_LABELS).toEqual({ AUTO: "Automático", TACO: "Taco", MANUAL: "A mano" });
    expect(RETENTION_HOLD_LABELS.FIXED_ASSET).toBe("Inmovilizado");
    expect(RETENTION_HOLD_LABELS.INSPECTION).toBe("Inspección o pleito");
  });
});
