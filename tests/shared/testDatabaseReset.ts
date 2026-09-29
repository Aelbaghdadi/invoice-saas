/**
 * Vaciar una base de datos de pruebas ya validada por su URL
 * (testDatabase.ts). Antes del TRUNCATE se comprueba contra la propia base de
 * datos que la conexion llega a la que dice la URL y que lleva la tabla
 * marcador del harness: si no, no se toca nada.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { TEST_DATABASE_MARKER, type TestDatabase } from "./testDatabase";

// Solo las tablas de los modelos de Prisma (ninguno usa @@map), no todo el
// schema public: ni la de migraciones ni nada ajeno.
export const MODEL_TABLES = Object.values(Prisma.ModelName).map((name) => `"${name}"`).join(", ");

/** Lanza si la conexion no llega a `db` o si falta el marcador. */
export async function assertHarnessDatabase(prisma: PrismaClient, db: TestDatabase, label: string): Promise<void> {
  const [{ current_database }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (current_database !== db.database) {
    throw new Error(`[${label}] La URL dice «${db.database}» pero la conexión llega a «${current_database}». No se toca nada.`);
  }
  const [{ marker }] = await prisma.$queryRaw<{ marker: string | null }[]>`
    SELECT to_regclass(${TEST_DATABASE_MARKER})::text AS marker`;
  if (!marker) {
    throw new Error(`[${label}] Falta ${TEST_DATABASE_MARKER} en «${db.database}»: no es una base de datos del harness. No se vacía.`);
  }
}

/**
 * Vacia las tablas de la app. TRUNCATE no dispara los triggers de fila de
 * AuditLog (append-only): por eso la comprobacion va justo antes.
 */
export async function truncateTestDatabase(prisma: PrismaClient, db: TestDatabase, label: string): Promise<void> {
  await assertHarnessDatabase(prisma, db, label);
  await prisma.$executeRawUnsafe(`TRUNCATE ${MODEL_TABLES} RESTART IDENTITY CASCADE`);
}
