// Eleccion de via para los PDF con Gemini (F-013, revision 1 del PR #9):
// texto solo si vale; si no, o si con el texto no sale lo basico, imagen.
// fetch simulado: nunca se llama a Gemini.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfWithGemini, isUsefulPdfText } from "@/lib/ocrLlm";

const factura = {
  issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: "Cliente SA", receiverCif: "A58818501",
  invoiceNumber: "F-1", invoiceDate: "2026-09-14", taxBase: 100, vatRate: 21, vatAmount: 21,
  irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
  vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
};

/** Lo que pide cada llamada: "texto" o "imagen". */
let calls: string[];
let textReply: object;

beforeEach(() => {
  calls = [];
  textReply = factura;
  vi.stubEnv("GEMINI_API_KEY", "prueba");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const isImage = body.contents[0].parts.some((p: object) => "inlineData" in p);
    calls.push(isImage ? "imagen" : "texto");
    const reply = isImage ? factura : textReply;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function pdfWithText(lines: string[]): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 16, size: 10, font }));
  return Buffer.from(await doc.save()).toString("base64");
}

describe("extractPdfWithGemini: vía de texto o de imagen", () => {
  it("un PDF digital de la demo va por texto", async () => {
    const { source } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_text", ["texto"]]);
  });

  it("un escaneado (sin texto) va por imagen", async () => {
    const { source } = await extractPdfWithGemini(await pdfWithText([]));
    expect([source, calls]).toEqual(["gemini_multimodal", ["imagen"]]);
  });

  it("solo con el sello de registro en texto va por imagen", async () => {
    const { source } = await extractPdfWithGemini(await pdfWithText([
      "REGISTRO GENERAL DE ENTRADA - AYUNTAMIENTO DE LEGANES - Oficina de Asistencia en Materia de Registros",
      "Numero de registro 2026/004512 - Fecha y hora de presentacion 14/09/2026 10:32 - Documento digitalizado",
    ]));
    expect([source, calls]).toEqual(["gemini_multimodal", ["imagen"]]);
  });

  it("lo que no es un PDF va por imagen", async () => {
    const { source } = await extractPdfWithGemini(Buffer.from("no es un pdf").toString("base64"));
    expect(source).toBe("gemini_multimodal");
  });

  it("si con el texto no sale el total o el CIF del emisor, se repite por imagen", async () => {
    textReply = { ...factura, totalAmount: null };
    const { source, result } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_multimodal", ["texto", "imagen"]]);
    expect(result.extracted.totalAmount).toBe(121);
  });
});

describe("isUsefulPdfText", () => {
  const base = "FACTURA Nº F-2026-0042 Proveedor Ejemplo SL CIF B12345674 Cliente Ejemplo SA NIF A58818501 ";
  it("con texto, un importe y un NIF: sí", () => {
    expect(isUsefulPdfText(base + "Base imponible 100,00 IVA 21 % 21,00 Total 121,00")).toBe(true);
    expect(isUsefulPdfText(base.replace("B12345674", "B-12345674").replace("A58818501", "") + "Base imponible 100,00 IVA 21,00 Total 121,00")).toBe(true);
  });

  it("una capa OCR mala, sin importes legibles: no", () => {
    expect(isUsefulPdfText("FACTURA Nº F-2026-0042 Proveedor Ejemplo SL C1F B4567B919 Cliente Ejemplo SA domicilio Calle Mayor T0TAL 217,8O")).toBe(false);
  });

  it("con muchos caracteres rotos: no", () => {
    expect(isUsefulPdfText(base + "Total 121,00 " + "�".repeat(10))).toBe(false);
  });

  it("corto (los espacios no cuentan): no", () => {
    expect(isUsefulPdfText("B12345674 121,00" + " ".repeat(200))).toBe(false);
  });
});
