-- Soporte de facturas rectificativas (abonos / correcciones).

CREATE TYPE "RectificativeType" AS ENUM ('BY_DIFFERENCE', 'BY_SUBSTITUTION');

ALTER TABLE "Invoice"
  ADD COLUMN "isRectificative"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rectifiedInvoiceSeries" TEXT,
  ADD COLUMN "rectifiedInvoiceNumber" TEXT,
  ADD COLUMN "rectificativeType"      "RectificativeType",
  ADD COLUMN "art80Tres"              BOOLEAN NOT NULL DEFAULT false;

-- Índice para detectar duplicados de número rectificativo en el mismo NIF.
-- A3 no permite dos facturas con el mismo (NIF, número), asi que en el
-- export tenemos que añadir sufijo _R cuando coincidan. Este índice
-- acelera esa consulta.
CREATE INDEX "Invoice_clientId_issuerCif_invoiceNumber_idx"
  ON "Invoice"("clientId", "issuerCif", "invoiceNumber");
