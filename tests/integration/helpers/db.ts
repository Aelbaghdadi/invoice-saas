import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { TEST_DATABASE_MARKER } from "../setup/guard";

// Solo las tablas de los modelos de Prisma (ninguno usa @@map), no todo el
// schema public: ni la de migraciones ni nada ajeno.
const MODEL_TABLES = Object.values(Prisma.ModelName).map((name) => `"${name}"`).join(", ");
let markerChecked = false;

/**
 * Vacia las tablas de la app. TRUNCATE no dispara los triggers de fila de
 * AuditLog (append-only), asi que no hace falta el bypass; por lo mismo, antes
 * del primer TRUNCATE se vuelve a comprobar que la base de datos es del
 * harness.
 */
export async function resetDatabase() {
  if (!markerChecked) {
    const [{ marker }] = await prisma.$queryRaw<{ marker: string | null }[]>`
      SELECT to_regclass(${TEST_DATABASE_MARKER})::text AS marker`;
    if (!marker) throw new Error(`[tests de integración] Falta ${TEST_DATABASE_MARKER}: esta base de datos no es del harness. No se vacía.`);
    markerChecked = true;
  }
  await prisma.$executeRawUnsafe(`TRUNCATE ${MODEL_TABLES} RESTART IDENTITY CASCADE`);
}

export async function disconnect() {
  await prisma.$disconnect();
}

export { prisma };
