-- Cuentas por defecto para facturas simplificadas / tickets sin datos
-- suficientes. El gestor las aplica manualmente desde revisión para
-- agrupar esos tickets en una sola cuenta (ej. proveedor "4999999").
-- Ambas columnas son opcionales (NULL = sin configurar para ese cliente).
ALTER TABLE "Client" ADD COLUMN "simplifiedSupplierAccount" TEXT;
ALTER TABLE "Client" ADD COLUMN "simplifiedExpenseAccount" TEXT;
