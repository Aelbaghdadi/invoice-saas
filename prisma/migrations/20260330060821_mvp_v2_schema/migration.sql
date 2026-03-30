-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceStatus" ADD VALUE 'ANALYZED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'OCR_ERROR';
ALTER TYPE "InvoiceStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "exportBatchId" TEXT,
ADD COLUMN     "fileHash" TEXT,
ADD COLUMN     "lastOcrError" TEXT,
ADD COLUMN     "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "reviewedBy" TEXT;

-- CreateTable
CREATE TABLE "InvoiceExtraction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rawResponse" TEXT,
    "source" TEXT NOT NULL,
    "issuerName" TEXT,
    "issuerCif" TEXT,
    "receiverName" TEXT,
    "receiverCif" TEXT,
    "invoiceNumber" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "taxBase" DECIMAL(12,2),
    "vatRate" DECIMAL(5,2),
    "vatAmount" DECIMAL(12,2),
    "irpfRate" DECIMAL(5,2),
    "irpfAmount" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2),
    "isValid" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceStatusHistory" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "fromStatus" "InvoiceStatus",
    "toStatus" "InvoiceStatus" NOT NULL,
    "reason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportBatch" (
    "id" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "clientId" TEXT,
    "periodMonth" INTEGER,
    "periodYear" INTEGER,
    "invoiceType" TEXT,
    "invoiceCount" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportBatch_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_exportBatchId_fkey" FOREIGN KEY ("exportBatchId") REFERENCES "ExportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceExtraction" ADD CONSTRAINT "InvoiceExtraction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceStatusHistory" ADD CONSTRAINT "InvoiceStatusHistory_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
