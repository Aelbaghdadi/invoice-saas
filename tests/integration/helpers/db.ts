import { prisma } from "@/lib/prisma";

let tables: string[] | null = null;

/**
 * Vacia todas las tablas menos la de migraciones. TRUNCATE no dispara los
 * triggers de fila de AuditLog (append-only), asi que no hace falta el bypass.
 */
export async function resetDatabase() {
  tables ??= (
    await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  ).map((t) => `"${t.tablename}"`);
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  }
}

export async function disconnect() {
  await prisma.$disconnect();
}

export { prisma };
