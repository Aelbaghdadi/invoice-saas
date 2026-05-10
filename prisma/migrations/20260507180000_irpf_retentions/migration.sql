-- Retenciones IRPF: tipo (Modelo 111 vs 115), base de retención y
-- aprendizaje por NIF.

CREATE TYPE "RetentionType" AS ENUM ('PROFESSIONAL', 'RENT');

ALTER TABLE "Invoice"
  ADD COLUMN "retentionType" "RetentionType",
  ADD COLUMN "retentionBase" DECIMAL(12, 2);

ALTER TABLE "AccountEntry"
  ADD COLUMN "defaultRetentionType" "RetentionType",
  ADD COLUMN "defaultRetentionRate" DECIMAL(5, 2);
