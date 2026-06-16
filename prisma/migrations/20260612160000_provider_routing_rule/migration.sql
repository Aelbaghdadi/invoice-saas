-- Aprendizaje de ruteo por proveedor: recuerda a qué empresa va cada proveedor
-- al clasificar a mano, para auto-rutear las siguientes facturas de ese proveedor.
CREATE TABLE "ProviderRoutingRule" (
    "id" TEXT NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,
    "providerNif" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderRoutingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderRoutingRule_advisoryFirmId_providerNif_key" ON "ProviderRoutingRule"("advisoryFirmId", "providerNif");
CREATE INDEX "ProviderRoutingRule_advisoryFirmId_idx" ON "ProviderRoutingRule"("advisoryFirmId");
CREATE INDEX "ProviderRoutingRule_clientId_idx" ON "ProviderRoutingRule"("clientId");

ALTER TABLE "ProviderRoutingRule" ADD CONSTRAINT "ProviderRoutingRule_advisoryFirmId_fkey"
    FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderRoutingRule" ADD CONSTRAINT "ProviderRoutingRule_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
