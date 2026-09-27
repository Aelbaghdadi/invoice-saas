import { describe, it, expect } from "vitest";
import { testDatabaseUrlProblem } from "../integration/setup/guard";

describe("guarda de la base de datos de los tests de integración", () => {
  it.each([
    "postgresql://postgres@127.0.0.1:55432/facturocr_test",
    "postgresql://postgres@localhost:5432/facturas",
    "postgres://u:p@[::1]:5432/app",
    "postgresql://u:p@db.interno:5432/facturocr_test",
  ])("acepta %s (local o con «test» en el nombre)", (url) => {
    expect(testDatabaseUrlProblem(url)).toBeNull();
  });

  it("sin TEST_DATABASE_URL no arranca (nunca cae a DATABASE_URL)", () => {
    expect(testDatabaseUrlProblem(undefined)).toMatch(/Falta TEST_DATABASE_URL/);
    expect(testDatabaseUrlProblem("")).toMatch(/Falta TEST_DATABASE_URL/);
  });

  it.each([
    "postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    "postgresql://u:p@produccion.midominio.es:5432/facturas",
  ])("rechaza una base de datos remota que no es de pruebas: %s", (url) => {
    expect(testDatabaseUrlProblem(url)).toMatch(/ni es local ni el nombre/);
  });

  it("rechaza lo que no es Postgres o no es una URL", () => {
    expect(testDatabaseUrlProblem("mysql://localhost/test")).toMatch(/Postgres/);
    expect(testDatabaseUrlProblem("no es una url")).toMatch(/no es una URL/);
  });
});
