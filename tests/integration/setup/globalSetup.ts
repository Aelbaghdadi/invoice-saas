import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireTestDatabase, TEST_DATABASE_MARKER, TEST_MARKER_SCHEMA, type TestDatabase } from "./guard";

/**
 * Una vez por ejecucion, antes de tocar nada:
 *  1. La URL pasa la guarda (nombre de pruebas, sin parametros de conexion).
 *  2. La base de datos a la que de verdad se conecta se llama asi.
 *  3. O esta vacia (se marca como del harness) o ya tiene la tabla marcador.
 *     Con datos y sin marcador, se aborta sin migrar.
 *  4. Se dice por stderr a que host y base de datos se va.
 *  5. `prisma migrate deploy` (las mismas migraciones que en produccion).
 */
function prismaCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("prisma/package.json");
  const bin = (require(pkg) as { bin: { prisma: string } }).bin.prisma;
  return path.join(path.dirname(pkg), bin);
}

async function checkAndMark(db: TestDatabase) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url }) });
  try {
    const [{ current_database }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (current_database !== db.database) {
      throw new Error(`[tests de integración] La URL dice «${db.database}» pero la conexión llega a «${current_database}». No se toca nada.`);
    }
    const [{ marker }] = await prisma.$queryRaw<{ marker: string | null }[]>`
      SELECT to_regclass(${TEST_DATABASE_MARKER})::text AS marker`;
    const [{ tables }] = await prisma.$queryRaw<{ tables: bigint }[]>`
      SELECT count(*) AS tables FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', ${TEST_MARKER_SCHEMA})`;
    if (!marker && Number(tables) > 0) {
      throw new Error(
        `[tests de integración] «${db.database}» en ${db.host} tiene ${tables} tablas y no es del harness (falta ${TEST_DATABASE_MARKER}). ` +
          "No se migra ni se vacía. Usa una base de datos vacía para los tests.",
      );
    }
    if (!marker) {
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${TEST_MARKER_SCHEMA}"`);
      await prisma.$executeRawUnsafe(`CREATE TABLE ${TEST_DATABASE_MARKER} (created_at timestamptz NOT NULL DEFAULT now())`);
      await prisma.$executeRawUnsafe(`INSERT INTO ${TEST_DATABASE_MARKER} DEFAULT VALUES`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

export default async function setup() {
  const db = requireTestDatabase();
  process.stderr.write(`[tests de integración] Base de datos: ${db.database} en ${db.host}:${db.port} (se vacía en cada test)\n`);
  await checkAndMark(db);
  execFileSync(process.execPath, [prismaCli(), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: db.url },
    stdio: ["ignore", process.stderr, "inherit"],
  });
}
