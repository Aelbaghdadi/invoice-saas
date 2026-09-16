-- Recargo de Equivalencia pasa de ser un valor unico por factura a ir POR
-- LINEA de IVA: cada tipo (21/10/4) tiene su propio recargo, y una linea
-- concreta (p.ej. portes) puede no llevarlo aunque el resto de la factura
-- si. El modelo anterior (un solo % y cuota por Invoice) no distinguia
-- entre lineas y no era lo que se habia pedido.

-- 1) Columnas nuevas en InvoiceVatLine.
ALTER TABLE "InvoiceVatLine" ADD COLUMN "equivalenceSurchargeRate" DECIMAL(5,2);
ALTER TABLE "InvoiceVatLine" ADD COLUMN "equivalenceSurchargeAmount" DECIMAL(12,2);

-- 2) Backfill defensivo: si alguna factura ya tenia el recargo antiguo (a
-- nivel de Invoice), se traslada a su primera linea de IVA antes de borrar
-- las columnas viejas. No hay nada que perder.
UPDATE "InvoiceVatLine" vl
SET "equivalenceSurchargeRate" = inv."equivalenceSurchargeRate",
    "equivalenceSurchargeAmount" = inv."equivalenceSurchargeAmount"
FROM "Invoice" inv
WHERE vl."invoiceId" = inv.id
  AND vl.position = 0
  AND inv."equivalenceSurchargeRate" IS NOT NULL;

-- 3) Las columnas viejas en Invoice dejan de existir.
ALTER TABLE "Invoice" DROP COLUMN "equivalenceSurchargeRate";
ALTER TABLE "Invoice" DROP COLUMN "equivalenceSurchargeAmount";
