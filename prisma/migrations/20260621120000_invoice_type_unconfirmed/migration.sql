-- Tipo de factura sin determinar al subir ("No lo sé"). El OCR intenta
-- detectarlo y el gestor lo confirma en la revisión. Mientras tanto `type`
-- guarda un valor provisional.
ALTER TABLE "Invoice" ADD COLUMN "typeUnconfirmed" BOOLEAN NOT NULL DEFAULT false;
