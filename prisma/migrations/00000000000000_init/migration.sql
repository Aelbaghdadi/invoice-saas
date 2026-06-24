-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'WORKER', 'CLIENT');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('PURCHASE', 'SALE');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('INTERIOR', 'AGRARIA', 'INTRACOM', 'INVERSION_SP', 'IMPORTACION', 'IVA_NO_DEDUCIBLE');

-- CreateEnum
CREATE TYPE "RetentionType" AS ENUM ('PROFESSIONAL', 'RENT');

-- CreateEnum
CREATE TYPE "RectificativeType" AS ENUM ('BY_DIFFERENCE', 'BY_SUBSTITUTION');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UPLOADED', 'ANALYZING', 'ANALYZED', 'PENDING_REVIEW', 'NEEDS_ATTENTION', 'OCR_ERROR', 'VALIDATED', 'REJECTED', 'EXPORTED', 'SPLIT_SOURCE', 'PENDING_ROUTING');

-- CreateEnum
CREATE TYPE "RejectionCategory" AS ENUM ('ILLEGIBLE', 'INCOMPLETE', 'WRONG_PERIOD', 'DUPLICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('OCR_FAILED', 'LOW_CONFIDENCE', 'POSSIBLE_DUPLICATE', 'MATH_MISMATCH', 'MANUAL');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AdvisoryFirm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cif" TEXT NOT NULL,
    "logoDataUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvisoryFirm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "advisoryFirmId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cif" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "accountingProgram" TEXT,
    "exportConfig" JSONB,
    "simplifiedSupplierAccount" TEXT,
    "simplifiedExpenseAccount" TEXT,
    "isUnclassifiedBucket" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRoutingRule" (
    "id" TEXT NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,
    "providerNif" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,

    CONSTRAINT "ClientGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,

    CONSTRAINT "ClientGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerClientAssignment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,

    CONSTRAINT "WorkerClientAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileHash" TEXT,
    "sizeBytes" INTEGER,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientId" TEXT NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileHash" TEXT,
    "type" "InvoiceType" NOT NULL,
    "typeUnconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UPLOADED',
    "operationType" "OperationType" NOT NULL DEFAULT 'INTERIOR',
    "issuerCountry" CHAR(2),
    "receiverCountry" CHAR(2),
    "periodType" "PeriodType" NOT NULL DEFAULT 'MONTHLY',
    "periodMonth" INTEGER NOT NULL,
    "periodYear" INTEGER NOT NULL,
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
    "retentionType" "RetentionType",
    "retentionBase" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2),
    "isValid" BOOLEAN,
    "isRectificative" BOOLEAN NOT NULL DEFAULT false,
    "rectifiedInvoiceSeries" TEXT,
    "rectifiedInvoiceNumber" TEXT,
    "rectificativeType" "RectificativeType",
    "art80Tres" BOOLEAN NOT NULL DEFAULT false,
    "supplierAccount" TEXT,
    "expenseAccount" TEXT,
    "rejectionReason" TEXT,
    "rejectionCategory" "RejectionCategory",
    "reviewedBy" TEXT,
    "replacesId" TEXT,
    "splitFromId" TEXT,
    "accountingPeriodMonth" INTEGER,
    "accountingPeriodYear" INTEGER,
    "ocrAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastOcrError" TEXT,
    "deferredAt" TIMESTAMP(3),
    "routingCandidateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routingReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentId" TEXT,
    "exportBatchId" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "InvoiceExtraction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rawResponse" TEXT,
    "source" TEXT NOT NULL,
    "confidence" JSONB,
    "ocrStartedAt" TIMESTAMP(3),
    "ocrFinishedAt" TIMESTAMP(3),
    "ocrDurationMs" INTEGER,
    "isReprocess" BOOLEAN NOT NULL DEFAULT false,
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
    "periodType" "PeriodType" NOT NULL DEFAULT 'MONTHLY',
    "periodMonth" INTEGER,
    "periodYear" INTEGER,
    "invoiceType" TEXT,
    "invoiceCount" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportBatchItem" (
    "id" TEXT NOT NULL,
    "exportBatchId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceIssue" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "IssueType" NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "field" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prevId" TEXT,
    "prevHash" TEXT NOT NULL DEFAULT 'GENESIS',
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeriodClosure" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "closedBy" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedAt" TIMESTAMP(3),
    "reopenedBy" TEXT,
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PeriodClosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountEntry" (
    "id" TEXT NOT NULL,
    "nif" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supplierAccount" TEXT NOT NULL,
    "expenseAccount" TEXT NOT NULL,
    "defaultVatRate" DECIMAL(5,2),
    "defaultOperationType" "OperationType",
    "defaultRetentionType" "RetentionType",
    "defaultRetentionRate" DECIMAL(5,2),
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvisoryFirm_cif_key" ON "AdvisoryFirm"("cif");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_cif_key" ON "Client"("cif");

-- CreateIndex
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_userId_key" ON "Client"("userId");

-- CreateIndex
CREATE INDEX "ProviderRoutingRule_advisoryFirmId_idx" ON "ProviderRoutingRule"("advisoryFirmId");

-- CreateIndex
CREATE INDEX "ProviderRoutingRule_clientId_idx" ON "ProviderRoutingRule"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRoutingRule_advisoryFirmId_providerNif_key" ON "ProviderRoutingRule"("advisoryFirmId", "providerNif");

-- CreateIndex
CREATE INDEX "ClientGroup_advisoryFirmId_idx" ON "ClientGroup"("advisoryFirmId");

-- CreateIndex
CREATE INDEX "ClientGroupMember_clientId_idx" ON "ClientGroupMember"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientGroupMember_groupId_clientId_key" ON "ClientGroupMember"("groupId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerClientAssignment_workerId_clientId_key" ON "WorkerClientAssignment"("workerId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_replacesId_key" ON "Invoice"("replacesId");

-- CreateIndex
CREATE INDEX "Invoice_clientId_status_idx" ON "Invoice"("clientId", "status");

-- CreateIndex
CREATE INDEX "Invoice_issuerCif_idx" ON "Invoice"("issuerCif");

-- CreateIndex
CREATE INDEX "Invoice_periodMonth_periodYear_idx" ON "Invoice"("periodMonth", "periodYear");

-- CreateIndex
CREATE INDEX "InvoiceVatLine_invoiceId_idx" ON "InvoiceVatLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExportBatchItem_exportBatchId_invoiceId_key" ON "ExportBatchItem"("exportBatchId", "invoiceId");

-- CreateIndex
CREATE INDEX "AuditLog_invoiceId_createdAt_idx" ON "AuditLog"("invoiceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_prevId_idx" ON "AuditLog"("prevId");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodClosure_clientId_month_year_key" ON "PeriodClosure"("clientId", "month", "year");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");

-- CreateIndex
CREATE INDEX "AccountEntry_clientId_idx" ON "AccountEntry"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountEntry_clientId_nif_key" ON "AccountEntry"("clientId", "nif");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_advisoryFirmId_fkey" FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_advisoryFirmId_fkey" FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRoutingRule" ADD CONSTRAINT "ProviderRoutingRule_advisoryFirmId_fkey" FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRoutingRule" ADD CONSTRAINT "ProviderRoutingRule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientGroup" ADD CONSTRAINT "ClientGroup_advisoryFirmId_fkey" FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientGroupMember" ADD CONSTRAINT "ClientGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ClientGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientGroupMember" ADD CONSTRAINT "ClientGroupMember_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerClientAssignment" ADD CONSTRAINT "WorkerClientAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerClientAssignment" ADD CONSTRAINT "WorkerClientAssignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_exportBatchId_fkey" FOREIGN KEY ("exportBatchId") REFERENCES "ExportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceVatLine" ADD CONSTRAINT "InvoiceVatLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceExtraction" ADD CONSTRAINT "InvoiceExtraction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceStatusHistory" ADD CONSTRAINT "InvoiceStatusHistory_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBatchItem" ADD CONSTRAINT "ExportBatchItem_exportBatchId_fkey" FOREIGN KEY ("exportBatchId") REFERENCES "ExportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBatchItem" ADD CONSTRAINT "ExportBatchItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceIssue" ADD CONSTRAINT "InvoiceIssue_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodClosure" ADD CONSTRAINT "PeriodClosure_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountEntry" ADD CONSTRAINT "AccountEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
