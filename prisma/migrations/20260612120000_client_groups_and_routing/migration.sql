-- Auto-ruteo multicliente: el gestor sube un montón mezclado de facturas de
-- varias empresas (clientes) y el sistema las reparte por CIF.

-- 1) Estado nuevo: subida pendiente de auto-ruteo / clasificación manual.
ALTER TYPE "InvoiceStatus" ADD VALUE 'PENDING_ROUTING';

-- 2) Cliente técnico "Sin clasificar" por asesoría (buzón de las pendientes).
ALTER TABLE "Client" ADD COLUMN "isUnclassifiedBucket" BOOLEAN NOT NULL DEFAULT false;

-- 3) Campos de ruteo en Invoice.
ALTER TABLE "Invoice" ADD COLUMN "routingCandidateIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Invoice" ADD COLUMN "routingReason" TEXT;

-- 4) Grupos de clientes (empresas que se suben juntas para auto-ruteo).
CREATE TABLE "ClientGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "advisoryFirmId" TEXT NOT NULL,
    CONSTRAINT "ClientGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClientGroupMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    CONSTRAINT "ClientGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClientGroup_advisoryFirmId_idx" ON "ClientGroup"("advisoryFirmId");
CREATE UNIQUE INDEX "ClientGroupMember_groupId_clientId_key" ON "ClientGroupMember"("groupId", "clientId");
CREATE INDEX "ClientGroupMember_clientId_idx" ON "ClientGroupMember"("clientId");

ALTER TABLE "ClientGroup" ADD CONSTRAINT "ClientGroup_advisoryFirmId_fkey"
    FOREIGN KEY ("advisoryFirmId") REFERENCES "AdvisoryFirm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientGroupMember" ADD CONSTRAINT "ClientGroupMember_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "ClientGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientGroupMember" ADD CONSTRAINT "ClientGroupMember_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
