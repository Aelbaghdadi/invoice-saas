/**
 * Guarda de los tests de integracion: solo arrancan contra una base de datos
 * que sea claramente de pruebas, porque cada test la vacia (TRUNCATE).
 *
 * - La URL sale de TEST_DATABASE_URL y de nada mas: nunca de DATABASE_URL, que
 *   en local apunta a Supabase.
 * - Tiene que ser Postgres y, o estar en esta maquina (localhost, 127.0.0.1,
 *   ::1), o que el nombre de la base de datos lleve «test».
 *
 * Sin imports de Prisma ni de Next: la usan el globalSetup, el setup de cada
 * fichero y un test unitario.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Por que no se puede usar esa URL, o null si vale. */
export function testDatabaseUrlProblem(url: string | undefined): string | null {
  if (!url) {
    return "Falta TEST_DATABASE_URL. Los tests de integración nunca usan DATABASE_URL (en local apunta a Supabase). Ver ARCHITECTURE.md → Testing.";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "TEST_DATABASE_URL no es una URL válida.";
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return `TEST_DATABASE_URL tiene que ser de Postgres (es ${parsed.protocol}).`;
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const isLocal = LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
  const looksLikeTest = /test/i.test(database);
  if (!isLocal && !looksLikeTest) {
    return `TEST_DATABASE_URL apunta a ${parsed.hostname}/${database || "(sin base de datos)"}: ni es local ni el nombre de la base de datos lleva «test». Cada test la vacía, así que no se arranca.`;
  }
  return null;
}

/** La URL de pruebas, o lanza con el motivo. */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  const problem = testDatabaseUrlProblem(url);
  if (problem) throw new Error(`[tests de integración] ${problem}`);
  return url!;
}
