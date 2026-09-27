// Eleccion de via para los PDF con Gemini (F-013, revision 1 del PR #9):
// texto solo si vale; si no, o si con el texto no sale lo basico, imagen.
// fetch simulado: nunca se llama a Gemini.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { computeBboxesFromPdf, extractPdfTextAndItems, extractPdfWithGemini, isUsefulPdfText, pagesToRead, textHasTaxId } from "@/lib/ocrLlm";

const factura = {
  issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: "Cliente SA", receiverCif: "A58818501",
  invoiceNumber: "F-1", invoiceDate: "2026-09-14", taxBase: 100, vatRate: 21, vatAmount: 21,
  irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
  vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }],
};

/** Lo que pide cada llamada: "texto" o "imagen". */
let calls: string[];
let textReply: object;
let imageReply: object;
let imageStatus: number;

beforeEach(() => {
  calls = [];
  textReply = factura;
  imageReply = factura;
  imageStatus = 200;
  vi.stubEnv("GEMINI_API_KEY", "prueba");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const isImage = body.contents[0].parts.some((p: object) => "inlineData" in p);
    calls.push(isImage ? "imagen" : "texto");
    if (isImage && imageStatus !== 200) return new Response("demasiado grande", { status: imageStatus });
    const reply = isImage ? imageReply : textReply;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function pdfWithText(lines: string[], pages = 1): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line.replace("{p}", String(p + 1)), { x: 20, y: 820 - i * 11, size: 5, font }));
  }
  return Buffer.from(await doc.save()).toString("base64");
}

describe("extractPdfWithGemini: vía de texto o de imagen", () => {
  it("un PDF digital de la demo va por texto, y un trozo del texto queda en el JSON crudo", async () => {
    const { source, result } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_text", ["texto"]]);
    const raw = JSON.parse(result.rawJson);
    expect(raw.textExcerpt).toContain("B85800949");
    expect(raw.textExcerpt.length).toBe(raw.textLength);
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
    // El texto del PDF se conserva para las heurísticas.
    expect(result.rawText).toContain("B85800949");
  });

  it("si la imagen falla, se queda con lo que salió del texto (a revisar, no Error OCR)", async () => {
    textReply = { ...factura, totalAmount: null };
    imageStatus = 400;
    const { source, result } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_text", ["texto", "imagen"]]);
    expect(result.extracted.issuerCif).toBe("B12345674");
  });

  it("texto incompleto e imagen con 503: dos llamadas y el del texto, sin lanzar (el reintento no repetiría el texto)", async () => {
    textReply = { ...factura, totalAmount: null };
    imageStatus = 503;
    const { source } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_text", ["texto", "imagen"]]);
  });

  it("escaneado e imagen con 503: lanza (lo reintenta processInvoice) sin haber llamado por texto", async () => {
    imageStatus = 503;
    await expect(extractPdfWithGemini(await pdfWithText([]))).rejects.toThrow(/503/);
    expect(calls).toEqual(["imagen"]);
  });

  it("un total 0 con confianza 0 cuenta como que falta; con confianza, no (rectificativa a cero)", async () => {
    textReply = { ...factura, totalAmount: 0, confidence: { totalAmount: 0 } };
    await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect(calls).toEqual(["texto", "imagen"]);

    calls = [];
    textReply = { ...factura, totalAmount: 0, confidence: { totalAmount: 0.9 } };
    const { source } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect([source, calls]).toEqual(["gemini_text", ["texto"]]);
  });

  it("si la imagen tampoco saca el total, también el texto", async () => {
    textReply = { ...factura, totalAmount: null, invoiceNumber: "DEL-TEXTO" };
    imageReply = { ...factura, totalAmount: null };
    const { source, result } = await extractPdfWithGemini(readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64"));
    expect(source).toBe("gemini_text");
    expect(result.extracted.invoiceNumber).toBe("DEL-TEXTO");
  });
});

describe("isUsefulPdfText: cada requisito tiene su caso", () => {
  const cabecera = "FACTURA Nº F-2026-0042 · Proveedor Ejemplo SL · Calle Mayor 1, 28013 Madrid · Cliente Ejemplo SA · Gran Via 2 ";
  const importes = "Base imponible 100,00 · IVA 21 % 21,00 · Total 121,00";

  it("con texto, un importe y un NIF válido: sí", () => {
    expect(isUsefulPdfText(`${cabecera} CIF B12345674 ${importes}`)).toBe(true);
    expect(isUsefulPdfText(`${cabecera} CIF B-12345674 ${importes}`)).toBe(true);
    expect(isUsefulPdfText(`${cabecera} VAT DE123456789 ${importes}`)).toBe(true);
  });

  it("corto (los espacios no cuentan): no", () => {
    expect(isUsefulPdfText(`B12345674 121,00${" ".repeat(200)}`)).toBe(false);
  });

  it("muchos caracteres rotos: no", () => {
    expect(isUsefulPdfText(`${cabecera} CIF B12345674 ${importes} ${"\uFFFD".repeat(10)}`)).toBe(false);
  });

  it("sin importes (el sello con fecha y hora con puntos, o un teléfono con puntos): no", () => {
    expect(isUsefulPdfText(`REGISTRO GENERAL DE ENTRADA · Ayuntamiento de Leganés · CIF P2807400B · ${cabecera} Fecha 14.09.2026 Hora 10.32.15`)).toBe(false);
    expect(isUsefulPdfText(`${cabecera} CIF B12345674 · Teléfono 91.123.45.67 · www.ejemplo.es`)).toBe(false);
  });

  it("sin un NIF de verdad (palabras con números, un pedido o un CIF con el dígito mal): no", () => {
    expect(isUsefulPdfText(`${cabecera} REGISTRO2026 FACTURA2026 ALBARAN2026 IMPONIBLE100 Pedido 12345678 ${importes}`)).toBe(false);
    expect(isUsefulPdfText(`${cabecera} C1F B4567B919 Pedido 12345678 T0TAL 217,80`)).toBe(false);
    expect(isUsefulPdfText(`${cabecera} CIF B12345678 ${importes}`)).toBe(false);
  });
});

describe("importes", () => {
  it("121,00, 1.234,56, 1,234.56 y -21.00 cuentan; fechas, horas y teléfonos con puntos, no", () => {
    const withId = (amount: string) => isUsefulPdfText(`FACTURA F-1 Proveedor Ejemplo SL Calle Mayor 1 Madrid Cliente Ejemplo SA Gran Via 2 Madrid Servicio de mantenimiento CIF B12345674 importe ${amount}`);
    for (const amount of ["121,00", "1.234,56", "1,234.56", "-21.00", "3.000,00"]) expect(withId(amount), amount).toBe(true);
    for (const other of ["14.09.2026", "10.32.15", "91.123.45.67", "14/09/26"]) expect(withId(other), other).toBe(false);
  });
});

describe("textHasTaxId", () => {
  it("NIF, CIF y NIE con el dígito bien; VAT con prefijo de la lista", () => {
    for (const id of ["B12345674", "B 12345674", "X1234567L", "DE123456789", "FRXX123456789", "NL123456789B01", "ATU12345678", "CHE-123.456.789", "GB123456789"]) {
      expect(textHasTaxId(`CIF ${id}`), id).toBe(true);
    }
  });

  it("no lo que solo se le parece", () => {
    for (const text of ["REGISTRO2026", "PEDIDO12345678", "ESTADO12345678", "B12345678", "IMPONIBLE100"]) {
      expect(textHasTaxId(text), text).toBe(false);
    }
  });
});

describe("límites de la extracción (revisión 1 del PR #9, punto 2)", () => {
  it("lee las 5 primeras páginas y la última", () => {
    expect(pagesToRead(3)).toEqual([1, 2, 3]);
    expect(pagesToRead(50)).toEqual([1, 2, 3, 4, 5, 50]);
  });

  it("un PDF de 30 páginas: solo el texto de esas 6, con las demás marcadas como omitidas", async () => {
    const { text } = await extractPdfTextAndItems(await pdfWithText(["Pagina {p} de la factura"], 30));
    expect(text.match(/Pagina \d+/g)).toEqual(["Pagina 1", "Pagina 2", "Pagina 3", "Pagina 4", "Pagina 5", "Pagina 30"]);
    expect(text).toContain("[… páginas 6 a 29 omitidas …]\nPagina 30");
  });

  it("con 6 páginas o menos no hay nada que marcar", async () => {
    const { text } = await extractPdfTextAndItems(await pdfWithText(["Pagina {p} de la factura"], 6));
    expect(text).not.toContain("omitidas");
  });

  it("si se pasa del tiempo, texto vacío (y va por la imagen)", async () => {
    const pdf = readFileSync("scripts/demo-pdfs/amazon-oficina.pdf").toString("base64");
    expect(await extractPdfTextAndItems(pdf, -1)).toEqual({ text: "", items: [], timedOut: true });
  });

  it("a Gemini le llegan como mucho 40.000 caracteres, con el principio y el final", async () => {
    let sent = 0;
    let sentText = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      sentText = JSON.parse(init.body).contents[0].parts[0].text;
      sent = sentText.length;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(factura) }] } }] }));
    }));
    const line = "Concepto 0042 Servicio de mantenimiento mensual de la instalacion B12345674 importe 121,00 EUR ".repeat(2);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let p = 0; p < 6; p++) {
      const page = doc.addPage([595, 842]);
      for (let i = 0; i < 70; i++) page.drawText(line, { x: 20, y: 820 - i * 11, size: 5, font });
      if (p === 5) page.drawText("TOTAL ULTIMA PAGINA 999,99", { x: 20, y: 20, size: 5, font });
    }
    await extractPdfWithGemini(Buffer.from(await doc.save()).toString("base64"));
    expect(sent).toBeGreaterThan(39_000);
    expect(sent).toBeLessThanOrEqual(40_000 + "Extrae los campos de esta factura:\n\n".length + "\n[… texto recortado …]\n".length);
    expect(sentText).toContain("[… texto recortado …]");
    // La última página (la de los totales) llega.
    expect(sentText).toContain("TOTAL ULTIMA PAGINA 999,99");
  });
});

describe("cajas del visor (revisión 1 del PR #9, punto 3)", () => {
  it("encuentra el CIF y el total (en formato español) en un PDF de la demo", async () => {
    const boxes = await computeBboxesFromPdf(
      readFileSync("scripts/demo-pdfs/rectificativas/4-multi-iva-mixto.pdf").toString("base64"),
      { issuerCif: "A12345674", totalAmount: 38.5, invoiceNumber: "SM-2026-0142-R" },
    );
    expect(Object.keys(boxes).sort()).toEqual(["invoiceNumber", "issuerCif", "totalAmount"]);
    expect(boxes.totalAmount!.width).toBeGreaterThan(0);
  });
});
