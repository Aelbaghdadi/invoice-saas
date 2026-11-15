-- CreateEnum
CREATE TYPE "SupportTicketSource" AS ENUM ('USER', 'AUTO');

-- DropForeignKey
ALTER TABLE "SupportMessage" DROP CONSTRAINT "SupportMessage_authorId_fkey";

-- DropForeignKey
ALTER TABLE "SupportTicket" DROP CONSTRAINT "SupportTicket_createdById_fkey";

-- AlterTable
ALTER TABLE "SupportMessage" ALTER COLUMN "authorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "occurrences" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "source" "SupportTicketSource" NOT NULL DEFAULT 'USER',
ALTER COLUMN "advisoryFirmId" DROP NOT NULL,
ALTER COLUMN "createdById" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "SupportTicket_fingerprint_status_idx" ON "SupportTicket"("fingerprint", "status");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
