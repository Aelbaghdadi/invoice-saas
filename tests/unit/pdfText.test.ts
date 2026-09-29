// F-013: el texto de los PDF digitales se extrae en el servidor. Antes
// GlobalWorkerOptions.workerSrc = "" rompia pdfjs en Node y todos salian con
// texto vacio, como escaneados.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { extractPdfTextAndItems } from "@/lib/ocrLlm";

const pdf = (path: string) => readFileSync(path).toString("base64");

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
