-- Auditoría inmutable: AuditLog es append-only a nivel de BD. La función
-- audit_log_immutable() bloquea UPDATE/DELETE salvo bypass explícito por una
-- variable de sesión (que solo activa la lib de reset de demo). pgcrypto se
-- mantiene por si alguna utilidad necesita digest().
--
-- (En el historial antiguo esto vivía en dos migraciones: audit_hash_chain
--  y audit_bypass_for_demo_reset. Aquí va ya la versión final consolidada;
--  las columnas de la cadena de hash las crea el baseline desde el schema.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- Bypass explícito (current_setting con missing_ok=true devuelve '' si la
  -- variable no está definida, sin error). Solo lo usa la lib de reset de demo.
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
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
