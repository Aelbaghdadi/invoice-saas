import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { extractInvoiceFromXml } from "@/lib/ocr";

// Estructura de Facturae 3.2.2 (con el prefijo fe: y la fecha en
// InvoiceIssueData, como la genera el programa de la AEAT).
const facturae322 = readFileSync("tests/unit/fixtures/facturae-3.2.2.xml", "utf-8");

describe("Facturae: fecha de emisión", () => {
  it("3.2.2: la lee de InvoiceIssueData", async () => {
    const { extracted } = await extractInvoiceFromXml(facturae322);
    expect(extracted.invoiceDate).toBe("2026-09-14");
    expect([extracted.issuerCif, extracted.totalAmount, extracted.currency]).toEqual(["B12345674", 121, "EUR"]);
    // Tal cual: antes «0042» llegaba como «42».
    expect(extracted.invoiceNumber).toBe("0042");
    expect([extracted.taxBase, extracted.vatRate, extracted.vatAmount]).toEqual([100, 21, 21]);
  });

  it("si solo viene en InvoiceHeader (XML antiguos), también", async () => {
    const xml = facturae322
      .replace("<IssueDate>2026-09-14</IssueDate>", "")
      .replace("<InvoiceNumber>0042</InvoiceNumber>", "<InvoiceNumber>0042</InvoiceNumber><IssueDate>2026-09-15</IssueDate>");
    const { extracted } = await extractInvoiceFromXml(xml);
    expect(extracted.invoiceDate).toBe("2026-09-15");
  });
});

describe("Facturae: los textos numéricos no se convierten", () => {
  it("«1.10» y «12E4» como número de factura llegan tal cual", async () => {
    for (const number of ["1.10", "12E4"]) {
      const { extracted } = await extractInvoiceFromXml(facturae322.replace("<InvoiceNumber>0042</InvoiceNumber>", `<InvoiceNumber>${number}</InvoiceNumber>`));
      expect(extracted.invoiceNumber).toBe(number);
    }
  });
});

describe("Facturae: lote con varias facturas", () => {
  it("se rechaza con un mensaje para el gestor, en vez de quedarse con la primera", async () => {
    const invoice = facturae322.slice(facturae322.indexOf("<Invoice>"), facturae322.indexOf("</Invoice>") + "</Invoice>".length);
    const lote = facturae322.replace(invoice, invoice + invoice.replace("0042", "0043"));
    await expect(extractInvoiceFromXml(lote)).rejects.toThrow("El XML trae 2 facturas (lote): súbelas por separado.");
  });
});
