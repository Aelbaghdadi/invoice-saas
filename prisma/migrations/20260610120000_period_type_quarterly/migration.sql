-- Soporte para lotes trimestrales.
-- Cuando periodType = 'QUARTERLY', periodMonth almacena el primer mes
-- del trimestre: Q1=1, Q2=4, Q3=7, Q4=10.
-- Todos los registros existentes son mensuales → DEFAULT 'MONTHLY'.

CREATE TYPE "PeriodType" AS ENUM ('MONTHLY', 'QUARTERLY');

ALTER TABLE "Invoice" ADD COLUMN "periodType" "PeriodType" NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "ExportBatch" ADD COLUMN "periodType" "PeriodType" NOT NULL DEFAULT 'MONTHLY';
