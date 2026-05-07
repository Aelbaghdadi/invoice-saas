-- Ambito fiscal de la factura para tratar inversion del sujeto pasivo
-- (intracomunitarias / internacionales sin IVA en factura).
CREATE TYPE "InvoiceScope" AS ENUM ('NATIONAL', 'INTRACOM', 'INTERNATIONAL');

ALTER TABLE "Invoice"
  ADD COLUMN "scope" "InvoiceScope" NOT NULL DEFAULT 'NATIONAL',
  ADD COLUMN "issuerCountry" CHAR(2);

-- Backfill: las facturas existentes se asumen NATIONAL (lo eran antes
-- de existir este campo). Si alguna realmente fuera intracomunitaria,
-- el gestor la corregira manualmente desde la pantalla de revision.
-- No tocamos nada mas — el default ya las deja en NATIONAL.

CREATE INDEX "Invoice_scope_idx" ON "Invoice"("scope");
