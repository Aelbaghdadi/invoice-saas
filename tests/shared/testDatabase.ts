/**
 * Guarda de los tests que vacian la base de datos (integracion y e2e): solo
 * arrancan contra una que sea claramente de pruebas, porque la vacian
 * (TRUNCATE, que se salta tambien los triggers de AuditLog).
 *
 * - La URL sale de su propia variable (TEST_DATABASE_URL en integracion,
 *   E2E_DATABASE_URL en e2e) y de nada mas: nunca de DATABASE_URL, que en
 *   local apunta a Supabase.
 * - Tiene que ser Postgres y el nombre de la base de datos tiene que ser de
 *   pruebas con limite de palabra («facturocr_test», «test», «tests-local»),
 *   este donde este: un tunel SSH o un volcado de produccion en localhost
 *   tambien estan «en local».
 * - Sin parametros de conexion en la query (?host=, ?dbname=…): pg y Prisma
 *   los obedecen y cambiarian el destino que se ha validado.
 *
 * Ademas, antes de vaciar, se comprueba contra la propia base de datos el
 * nombre y la tabla marcador (ver TEST_DATABASE_MARKER y testDatabaseReset).
 *
 * Sin imports de Prisma ni de Next: la usan el globalSetup, el setup de cada
 * fichero, el e2e y un test unitario.
 */
const TEST_NAME = /(^|[_-])tests?([_-]|$)/i;

/** Parametros de la query que cambian a donde se conecta. */
const CONNECTION_PARAMS = new Set([
  "host", "hostaddr", "port", "dbname", "database", "user", "options",
  "service", "servicefile", "passfile", "target_session_attrs", "socket",
]);

/**
 * Tabla que marca una base de datos como del harness. Se crea la primera vez,
 * solo sobre una base de datos vacia; si hay datos y no esta, no se toca nada.
 * Va en su propio schema y no en public: `prisma migrate deploy` se niega a
 * migrar un public con tablas que no son suyas (P3005).
 */
export const TEST_MARKER_SCHEMA = "_facturocr_test";
export const TEST_DATABASE_MARKER = `"${TEST_MARKER_SCHEMA}"."marker"`;

export type TestDatabase = { url: string; host: string; port: string; database: string };

/** La base de datos validada, o el motivo por el que no se puede usar. */
export function parseTestDatabaseUrl(
  url: string | undefined,
  variable = "TEST_DATABASE_URL",
): { ok: true; db: TestDatabase } | { ok: false; problem: string } {
  if (!url) {
    return { ok: false, problem: `Falta ${variable}. Estos tests nunca usan DATABASE_URL (en local apunta a Supabase). Ver ARCHITECTURE.md → Testing.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, problem: `${variable} no es una URL válida.` };
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return { ok: false, problem: `${variable} tiene que ser de Postgres (es ${parsed.protocol}).` };
  }
  if (!parsed.hostname) {
    return { ok: false, problem: `${variable} no dice a qué host conectarse.` };
  }
  const blocked = [...parsed.searchParams.keys()].filter((k) => CONNECTION_PARAMS.has(k.toLowerCase()));
  if (blocked.length > 0) {
    return { ok: false, problem: `${variable} lleva parámetros que cambian el destino (${blocked.join(", ")}): pon el host, el puerto y la base de datos en la propia URL.` };
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!TEST_NAME.test(database)) {
    return { ok: false, problem: `${variable} apunta a la base de datos «${database || "(ninguna)"}» en ${parsed.hostname}: el nombre tiene que ser de pruebas («facturocr_test», «test»…). Los tests la vacían, así que no se arranca.` };
  }
  return { ok: true, db: { url, host: parsed.hostname, port: parsed.port || "5432", database } };
}

/** Compatibilidad con el test unitario: el motivo, o null si vale. */
export function testDatabaseUrlProblem(url: string | undefined): string | null {
  const result = parseTestDatabaseUrl(url);
  return result.ok ? null : result.problem;
}

/** La base de datos de pruebas, o lanza con el motivo. */
export function requireTestDatabase(): TestDatabase {
  const result = parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  if (!result.ok) throw new Error(`[tests de integración] ${result.problem}`);
  return result.db;
}
