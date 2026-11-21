import { describe, it, expect } from "vitest";
import {
  parsePageReadings,
  segmentPages,
  segmentationSummary,
  worthSplitting,
  type PageReading,
} from "@/lib/pdfSegmentation";

const factura = (page: number, invoiceNumber: string | null, startsInvoice = false, issuerCif: string | null = "B12345674"): PageReading =>
  ({ page, kind: "FACTURA", startsInvoice, invoiceNumber, issuerCif });
const otra = (page: number, kind: "ALBARAN" | "EN_BLANCO" | "OTRO"): PageReading =>
  ({ page, kind, startsInvoice: false, invoiceNumber: null, issuerCif: null });

describe("segmentPages", () => {
  it("una factura de varias páginas no se parte", () => {
    const seg = segmentPages([factura(1, "F-1", true), factura(2, "F-1"), factura(3, null)], 3);
    expect(seg).toEqual({ invoices: [[1, 2, 3]], discarded: [] });
    expect(worthSplitting(seg)).toBe(false);
  });

  it("la cabecera repetida en cada página no abre otra factura", () => {
    const seg = segmentPages([factura(1, "F-1", true), factura(2, "F 1", true)], 2);
    expect(seg?.invoices).toEqual([[1, 2]]);
  });

  it("un taco: varias facturas con albaranes y páginas en blanco por medio", () => {
    const seg = segmentPages([
      factura(1, "F-1", true),
      otra(2, "EN_BLANCO"),
      factura(3, "A-77", true, "B87654321"),
      factura(4, "A-77", false, "B87654321"),
      otra(5, "ALBARAN"),
      factura(6, "F-2", true),
    ], 6);
    expect(seg).toEqual({
      invoices: [[1], [3, 4], [6]],
      discarded: [{ page: 2, kind: "EN_BLANCO" }, { page: 5, kind: "ALBARAN" }],
    });
    expect(worthSplitting(seg)).toBe(true);
    expect(segmentationSummary(seg!)).toBe("3 facturas · descartadas: p. 2 (en blanco), p. 5 (albarán)");
  });

  it("otro número u otro emisor abre factura aunque Gemini no marque el inicio", () => {
    expect(segmentPages([factura(1, "F-1"), factura(2, "F-2")], 2)?.invoices).toEqual([[1], [2]]);
    expect(segmentPages([factura(1, null, false, "B12345674"), factura(2, null, false, "B87654321")], 2)?.invoices)
      .toEqual([[1], [2]]);
  });

  it("el mismo CIF con y sin prefijo de país es el mismo emisor", () => {
    expect(segmentPages([factura(1, null, true, "ESB12345674"), factura(2, null, false, "B-12345674")], 2)?.invoices)
      .toEqual([[1, 2]]);
  });

  it("una factura con relleno: se separa para quitar el relleno", () => {
    const seg = segmentPages([factura(1, "F-1", true), otra(2, "OTRO")], 2);
    expect(worthSplitting(seg)).toBe(true);
    expect(segmentationSummary(seg!)).toBe("1 factura · descartadas: p. 2 (otro documento)");
  });

  it("ante la duda no separa: lectura incompleta, páginas repetidas o sin facturas", () => {
    expect(segmentPages([factura(1, "F-1", true)], 2)).toBeNull();
    expect(segmentPages([factura(1, "F-1", true), factura(1, "F-2", true)], 2)).toBeNull();
    expect(segmentPages([otra(1, "ALBARAN"), otra(2, "EN_BLANCO")], 2)).toBeNull();
    expect(worthSplitting(null)).toBe(false);
  });

  it("ordena por página aunque Gemini las devuelva desordenadas", () => {
    expect(segmentPages([factura(2, "F-2", true), factura(1, "F-1", true)], 2)?.invoices).toEqual([[1], [2]]);
  });
});

describe("parsePageReadings", () => {
  it("normaliza la respuesta de Gemini", () => {
    expect(parsePageReadings({
      pages: [
        { page: 1, kind: "factura", startsInvoice: true, invoiceNumber: " F-1 ", issuerCif: "B 12345674" },
        { page: "2", kind: "EN_BLANCO", startsInvoice: "true", invoiceNumber: "", issuerCif: null },
      ],
    })).toEqual([
      { page: 1, kind: "FACTURA", startsInvoice: true, invoiceNumber: "F-1", issuerCif: "B12345674" },
      { page: 2, kind: "EN_BLANCO", startsInvoice: false, invoiceNumber: null, issuerCif: null },
    ]);
  });

  it("null si la forma no es la esperada", () => {
    expect(parsePageReadings(null)).toBeNull();
    expect(parsePageReadings({ pages: "x" })).toBeNull();
    expect(parsePageReadings({ pages: [{ page: 1, kind: "PRESUPUESTO" }] })).toBeNull();
    expect(parsePageReadings({ pages: [{ page: 1.5, kind: "FACTURA" }] })).toBeNull();
  });
});
