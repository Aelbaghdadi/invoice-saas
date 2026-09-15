-- CreateEnum: de dónde sale la clasificación bienes/servicios de una factura
-- (IA, asignada al tercero, deducida de la cuenta 700/705 o marcada a mano).
CREATE TYPE "IntracomGoodsSource" AS ENUM ('IA', 'TERCERO', 'CUENTA', 'MANUAL');

-- AlterTable: origen de Invoice.intracomGoodsType. Nullable: las facturas
-- existentes quedan sin origen y la revisión lo muestra como "sin detectar".
ALTER TABLE "Invoice" ADD COLUMN     "intracomGoodsSource" "IntracomGoodsSource";

-- AlterTable: bienes o servicios asignado "siempre" a un tercero del plan de
-- cuentas, por sentido (compras / ventas). Nullable: sin asignar hasta que el
-- gestor lo confirma al validar.
ALTER TABLE "AccountEntry" ADD COLUMN     "intracomGoodsTypePurchase" "IntracomGoodsType",
ADD COLUMN     "intracomGoodsTypeSale" "IntracomGoodsType";

-- Backfill compras: el sistema nunca propone el tipo 8 (por país siempre sale
-- el 3), así que un proveedor con el 8 aprendido lo marcó el gestor. Se
-- conserva como servicios "siempre" para que la IA no lo pase a 3.
UPDATE "AccountEntry" SET "intracomGoodsTypePurchase" = 'SERVICIOS'
WHERE "defaultOperationType" = 'INTRACOM_SERVICIOS';

-- Backfill ventas: una cuenta 705 solo se aprende al validar una venta (en
-- compras se descarta cualquier 7xx) y la eligió el gestor. La 700 no se
-- toca: puede ser la cuenta de ingreso genérica.
UPDATE "AccountEntry" SET "intracomGoodsTypeSale" = 'SERVICIOS'
WHERE "defaultOperationType" = 'INTRACOM' AND "expenseAccount" LIKE '705%';
