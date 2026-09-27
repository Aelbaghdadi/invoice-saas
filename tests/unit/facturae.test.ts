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
  });

  it("si solo viene en InvoiceHeader (XML antiguos), también", async () => {
    const xml = facturae322
      .replace("<IssueDate>2026-09-14</IssueDate>", "")
      .replace("<InvoiceNumber>0042</InvoiceNumber>", "<InvoiceNumber>0042</InvoiceNumber><IssueDate>2026-09-15</IssueDate>");
    const { extracted } = await extractInvoiceFromXml(xml);
    expect(extracted.invoiceDate).toBe("2026-09-15");
  });
});
