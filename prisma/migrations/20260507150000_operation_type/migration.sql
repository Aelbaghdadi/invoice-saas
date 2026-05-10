-- Migración: sustituir InvoiceScope (3 valores) por OperationType (6 valores).
-- Mapeo de backfill:
--   NATIONAL      -> INTERIOR
--   INTRACOM      -> INTRACOM (mismo nombre, distinto enum)
--   INTERNATIONAL -> IMPORTACION

-- 1. Crear el nuevo enum
CREATE TYPE "OperationType" AS ENUM (
  'INTERIOR',
  'AGRARIA',
  'INTRACOM',
  'INVERSION_SP',
  'IMPORTACION',
  'IVA_NO_DEDUCIBLE'
);

-- 2. Añadir las nuevas columnas (NULL temporalmente para poder backfilll)
ALTER TABLE "Invoice" ADD COLUMN "operationType" "OperationType";
ALTER TABLE "AccountEntry" ADD COLUMN "defaultOperationType" "OperationType";

-- 3. Backfill desde el viejo scope
UPDATE "Invoice" SET "operationType" = CASE "scope"::text
  WHEN 'NATIONAL'      THEN 'INTERIOR'::"OperationType"
  WHEN 'INTRACOM'      THEN 'INTRACOM'::"OperationType"
  WHEN 'INTERNATIONAL' THEN 'IMPORTACION'::"OperationType"
  ELSE 'INTERIOR'::"OperationType"
END;

-- 4. Hacer la columna NOT NULL con default INTERIOR
ALTER TABLE "Invoice" ALTER COLUMN "operationType" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "operationType" SET DEFAULT 'INTERIOR';

-- 5. Drop el índice del viejo scope (si existía) + la columna + el enum
DROP INDEX IF EXISTS "Invoice_scope_idx";
ALTER TABLE "Invoice" DROP COLUMN "scope";
DROP TYPE "InvoiceScope";

-- 6. Indexar el nuevo campo (lo usamos para filtrar exports por tipo)
CREATE INDEX "Invoice_operationType_idx" ON "Invoice"("operationType");
