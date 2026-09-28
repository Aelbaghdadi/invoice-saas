import { prisma } from "@/lib/prisma";
import { requireTestDatabase } from "../../shared/testDatabase";
import { assertHarnessDatabase, MODEL_TABLES } from "../../shared/testDatabaseReset";

let markerChecked = false;

/**
 * Vacia las tablas de la app. TRUNCATE no dispara los triggers de fila de
 * AuditLog (append-only), asi que no hace falta el bypass; por lo mismo, antes
 * del primer TRUNCATE se vuelve a comprobar que la base de datos es del
 * harness.
 */
export async function resetDatabase() {
  if (!markerChecked) {
    await assertHarnessDatabase(prisma, requireTestDatabase(), "tests de integración");
    markerChecked = true;
  }
  await prisma.$executeRawUnsafe(`TRUNCATE ${MODEL_TABLES} RESTART IDENTITY CASCADE`);
}

export async function disconnect() {
  await prisma.$disconnect();
}

export { prisma };
