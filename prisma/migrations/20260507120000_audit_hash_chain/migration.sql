-- pgcrypto provides digest() para calcular sha256 en el backfill.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. Anadir columnas de cadena de hash ──────────────────────────────
ALTER TABLE "AuditLog"
  ADD COLUMN "prevId"   TEXT,
  ADD COLUMN "prevHash" TEXT NOT NULL DEFAULT 'GENESIS',
  ADD COLUMN "hash"     TEXT;

CREATE INDEX "AuditLog_invoiceId_createdAt_idx" ON "AuditLog"("invoiceId", "createdAt");
CREATE INDEX "AuditLog_prevId_idx" ON "AuditLog"("prevId");

-- ── 2. Backfill: encadenar los registros existentes por factura ───────
-- Para cada factura, ordenamos por createdAt asc y construimos la cadena.
-- El primer registro de cada factura tiene prevId=NULL y prevHash='GENESIS'.
DO $$
DECLARE
  rec RECORD;
  prev_id   TEXT;
  prev_hash TEXT;
  current_hash TEXT;
  current_invoice TEXT := NULL;
BEGIN
  FOR rec IN
    SELECT *
    FROM "AuditLog"
    ORDER BY "invoiceId", "createdAt", "id"
  LOOP
    -- Reset al cambiar de factura
    IF rec."invoiceId" IS DISTINCT FROM current_invoice THEN
      current_invoice := rec."invoiceId";
      prev_id := NULL;
      prev_hash := 'GENESIS';
    END IF;

    -- Calcular hash del registro actual
    current_hash := encode(
      digest(
        rec."id" || '|' ||
        rec."invoiceId" || '|' ||
        rec."userId" || '|' ||
        rec."field" || '|' ||
        COALESCE(rec."oldValue", '') || '|' ||
        COALESCE(rec."newValue", '') || '|' ||
        to_char(rec."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' ||
        prev_hash,
        'sha256'
      ),
      'hex'
    );

    UPDATE "AuditLog"
       SET "prevId"   = prev_id,
           "prevHash" = prev_hash,
           "hash"     = current_hash
     WHERE "id" = rec."id";

    prev_id := rec."id";
    prev_hash := current_hash;
  END LOOP;
END $$;

-- Hash ya no puede ser NULL despues del backfill
ALTER TABLE "AuditLog" ALTER COLUMN "hash" SET NOT NULL;

-- ── 3. Trigger: prohibir UPDATE y DELETE en AuditLog ──────────────────
-- Append-only a nivel BD. Ni siquiera el rol service_role puede modificar
-- registros. Solo INSERT esta permitido. Para emergencias verificadas se
-- puede hacer DROP TRIGGER + accion + recreate, pero queda en log de
-- migraciones de Postgres.
CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only — UPDATE/DELETE blocked (op=%)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "AuditLog"
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable();

