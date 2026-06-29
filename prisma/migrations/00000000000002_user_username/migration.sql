-- Login por nombre de usuario.
--
-- `username` pasa a ser obligatorio y único; el `email` se conserva (se sigue
-- usando para recuperación de contraseña y notificaciones, solo cambia CON QUÉ
-- se inicia sesión). Para no romper los usuarios que ya existan en la BD se
-- backfillea `username = email` antes de imponer NOT NULL: como `email` ya es
-- único, el `username` resultante también lo es y no hay colisiones.

-- 1. Columna nullable temporal (no rompe filas existentes).
ALTER TABLE "User" ADD COLUMN "username" TEXT;

-- 2. Backfill de los usuarios ya creados.
UPDATE "User" SET "username" = "email" WHERE "username" IS NULL;

-- 3. Ya con todas las filas rellenas, imponer la obligatoriedad.
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;

-- 4. Índice único (mismo nombre que generaría Prisma para `@unique`).
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
