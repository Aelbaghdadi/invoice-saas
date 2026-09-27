/** Ficheros de prueba. */

/** Facturae minima: el parser real la lee sin OCR (camino xml_parse). */
export function facturaeXml(opts: { number?: string; taxRate?: string; buyerCif?: string } = {}) {
  const { number = "F-XML-1", taxRate = "21.00", buyerCif = "B00000002" } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<fe:Facturae xmlns:fe="http://www.facturae.es/Facturae/2014/v3.2.1/Facturae">
  <Parties>
    <SellerParty><TaxIdentification><TaxIdentificationNumber>B12345674</TaxIdentificationNumber></TaxIdentification>
      <LegalEntity><CorporateName>Proveedor SL</CorporateName></LegalEntity></SellerParty>
    <BuyerParty><TaxIdentification><TaxIdentificationNumber>${buyerCif}</TaxIdentificationNumber></TaxIdentification>
      <LegalEntity><CorporateName>Cliente Prueba SL</CorporateName></LegalEntity></BuyerParty>
  </Parties>
  <Invoices><Invoice>
    <InvoiceHeader><InvoiceNumber>${number}</InvoiceNumber></InvoiceHeader>
    <InvoiceIssueData><IssueDate>2026-09-10</IssueDate></InvoiceIssueData>
    <TaxesOutputs><Tax><TaxRate>${taxRate}</TaxRate><TaxableBase><TotalAmount>100.00</TotalAmount></TaxableBase><TaxAmount><TotalAmount>21.00</TotalAmount></TaxAmount></Tax></TaxesOutputs>
    <InvoiceTotals><InvoiceTotal>121.00</InvoiceTotal></InvoiceTotals>
  </Invoice></Invoices>
</fe:Facturae>`;
}

/** PDF de n paginas en blanco (para dividir). */
export async function blankPdf(pages: number): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  // Sin addDefaultPage, save() anade una pagina en blanco a un PDF vacio.
  return Buffer.from(await doc.save({ addDefaultPage: false }));
}

/** PNG de 1x1, como data URL (recortes de imagen al dividir). */
export const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
