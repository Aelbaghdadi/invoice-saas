-- CreateTable
CREATE TABLE "InvoiceVatLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "taxBase" DECIMAL(12,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceVatLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceVatLine_invoiceId_idx" ON "InvoiceVatLine"("invoiceId");

-- AddForeignKey
ALTER TABLE "InvoiceVatLine" ADD CONSTRAINT "InvoiceVatLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: una linea por cada factura existente con IVA poblado.
-- Usamos cuid()-style id generado con gen_random_uuid() ya que cuid no
-- existe nativo en Postgres; el cliente Prisma usa cuid pero aqui solo
-- importa que sea unico. position=0 para todas (linea unica).
INSERT INTO "InvoiceVatLine" ("id", "invoiceId", "position", "taxBase", "vatRate", "vatAmount", "createdAt")
SELECT
    'vlb_' || REPLACE(gen_random_uuid()::text, '-', ''),
    "id",
    0,
    COALESCE("taxBase", 0),
    COALESCE("vatRate", 0),
    COALESCE("vatAmount", 0),
    "createdAt"
FROM "Invoice"
WHERE "taxBase" IS NOT NULL
   OR "vatAmount" IS NOT NULL
   OR "vatRate" IS NOT NULL;
