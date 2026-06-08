-- Nuevo estado para facturas origen de una división multi-ticket.
-- La foto original queda archivada (SPLIT_SOURCE) y excluida de la cola
-- activa, pero se conserva en BD para referencia y auditoría.

ALTER TYPE "InvoiceStatus" ADD VALUE 'SPLIT_SOURCE';

-- Enlace de sub-facturas hacia la foto origen de la que se extrajeron.
ALTER TABLE "Invoice" ADD COLUMN "splitFromId" TEXT;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_splitFromId_fkey"
  FOREIGN KEY ("splitFromId")
  REFERENCES "Invoice"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "Invoice_splitFromId_idx" ON "Invoice"("splitFromId");
