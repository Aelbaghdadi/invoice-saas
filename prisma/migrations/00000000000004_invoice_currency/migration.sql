-- Moneda de los importes detectada por el OCR (ISO 4217). Nullable: las
-- facturas existentes quedan a NULL y se tratan como euros.
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "currency" CHAR(3);
