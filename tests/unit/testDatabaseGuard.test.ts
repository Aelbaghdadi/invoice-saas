import { describe, it, expect } from "vitest";
import { parseTestDatabaseUrl, testDatabaseUrlProblem } from "../shared/testDatabase";

describe("guarda de la base de datos de los tests de integración", () => {
  it.each([
    "postgresql://postgres@127.0.0.1:55432/facturocr_test",
    "postgresql://postgres@localhost:5432/test",
    "postgres://u:p@[::1]:5432/tests-local",
    "postgresql://u:p@db.interno:5432/facturocr_test?sslmode=require",
  ])("acepta %s (nombre de pruebas)", (url) => {
    expect(testDatabaseUrlProblem(url)).toBeNull();
  });

  it("el e2e usa la misma guarda con su propia variable", () => {
    expect(parseTestDatabaseUrl(undefined, "E2E_DATABASE_URL")).toMatchObject({ ok: false, problem: expect.stringMatching(/^Falta E2E_DATABASE_URL/) });
    expect(parseTestDatabaseUrl("postgresql://u:p@localhost:5432/postgres", "E2E_DATABASE_URL")).toMatchObject({ ok: false, problem: expect.stringMatching(/^E2E_DATABASE_URL apunta/) });
  });

  it("sin TEST_DATABASE_URL no arranca (nunca cae a DATABASE_URL)", () => {
    expect(testDatabaseUrlProblem(undefined)).toMatch(/Falta TEST_DATABASE_URL/);
    expect(testDatabaseUrlProblem("")).toMatch(/Falta TEST_DATABASE_URL/);
  });

  it.each([
    // Local no basta: un tunel SSH o un volcado de produccion restaurado.
    "postgresql://postgres@localhost:5432/facturas",
    "postgresql://postgres@127.0.0.1:5432/postgres",
    // Remotas.
    "postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    "postgresql://u:p@produccion.midominio.es:5432/facturas",
    // «test» como subcadena, sin limite de palabra.
    "postgresql://u:p@localhost:5432/latest",
    "postgresql://u:p@localhost:5432/contests",
    "postgresql://u:p@localhost:5432/facturocrtest",
  ])("rechaza una base de datos que no se llama de pruebas: %s", (url) => {
    expect(testDatabaseUrlProblem(url)).toMatch(/el nombre tiene que ser de pruebas/);
  });

  it.each([
    "postgresql://u:p@localhost:5432/facturocr_test?host=remoto",
    "postgresql://u:p@localhost:5432/facturocr_test?hostaddr=10.0.0.5",
    "postgresql://u:p@localhost:5432/facturocr_test?dbname=facturas",
    "postgresql://u:p@localhost:5432/facturocr_test?PORT=6543",
    "postgresql://u:p@localhost:5432/facturocr_test?options=-c%20search_path%3Dprod",
    "postgresql://u:p@localhost:5432/facturocr_test?service=prod",
  ])("rechaza parámetros que cambian el destino: %s", (url) => {
    expect(testDatabaseUrlProblem(url)).toMatch(/cambian el destino/);
  });

  it("rechaza lo que no es Postgres o no es una URL", () => {
    expect(testDatabaseUrlProblem("mysql://localhost/test")).toMatch(/Postgres/);
    expect(testDatabaseUrlProblem("no es una url")).toMatch(/no es una URL/);
  });

  it("devuelve host, puerto y base de datos validados", () => {
    const r = parseTestDatabaseUrl("postgresql://u:p@127.0.0.1:55432/facturocr_test");
    expect(r).toMatchObject({ ok: true, db: { host: "127.0.0.1", port: "55432", database: "facturocr_test" } });
  });
});
