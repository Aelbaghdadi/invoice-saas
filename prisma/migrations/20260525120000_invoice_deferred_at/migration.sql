-- Posponer facturas: campo nullable que ordena al final de la cola de
-- revisión las facturas que el gestor marcó "para más tarde". Se limpia
-- automáticamente al editar/validar.
ALTER TABLE "Invoice" ADD COLUMN "deferredAt" TIMESTAMP(3);
