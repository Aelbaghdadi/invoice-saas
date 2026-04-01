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

-- CreateIndex
CREATE UNIQUE INDEX "PeriodClosure_clientId_month_year_key" ON "PeriodClosure"("clientId", "month", "year");

-- AddForeignKey
ALTER TABLE "PeriodClosure" ADD CONSTRAINT "PeriodClosure_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
