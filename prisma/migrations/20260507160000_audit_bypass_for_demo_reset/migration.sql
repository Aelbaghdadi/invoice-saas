-- El trigger original bloqueaba TODA modificación/borrado de AuditLog
-- incluyendo el "reset demo" legítimo. Lo evolucionamos para que respete
-- una variable de sesión PostgreSQL: si el caller la pone explícitamente,
-- el trigger la deja pasar. Cualquier otro código (UPDATE/DELETE
-- accidental, DBA con buenas intenciones, etc.) sigue bloqueado.
--
-- IMPORTANTE: la variable se usa con SET LOCAL dentro de una transacción
-- así no contamina otras conexiones. La aplicación SOLO la activa dentro
-- de la lib de reset demo, en ningún otro punto.

CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- Bypass explícito (current_setting con missing_ok=true devuelve ''
  -- si la variable no está definida, sin error).
  IF current_setting('app.allow_audit_mutation', true) = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only — UPDATE/DELETE blocked (op=%)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
