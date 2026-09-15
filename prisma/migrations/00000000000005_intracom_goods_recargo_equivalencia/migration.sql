-- AlterEnum: nuevo tipo de operación exclusivo de compras (A3 código 8,
-- adquisición intracomunitaria de SERVICIOS). No se usa en ventas.
ALTER TYPE "OperationType" ADD VALUE 'INTRACOM_SERVICIOS';

-- CreateEnum: clasificación bienes/servicios de una entrega intracomunitaria
-- (venta). A3 usa el mismo código de operación (3) para ambas; la
-- distinción se pide aparte para el modelo 349.
CREATE TYPE "IntracomGoodsType" AS ENUM ('BIENES', 'SERVICIOS');

-- AlterTable: flag de cliente minorista acogido a Recargo de Equivalencia.
ALTER TABLE "Client" ADD COLUMN "equivalenceSurchargeCustomer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: clasificación 349 (solo ventas) + recargo de equivalencia.
ALTER TABLE "Invoice" ADD COLUMN "intracomGoodsType" "IntracomGoodsType";
ALTER TABLE "Invoice" ADD COLUMN "equivalenceSurchargeRate" DECIMAL(5,2);
ALTER TABLE "Invoice" ADD COLUMN "equivalenceSurchargeAmount" DECIMAL(12,2);
