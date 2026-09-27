import { execFileSync } from "node:child_process";
import { requireTestDatabaseUrl } from "./guard";

/**
 * Una vez por ejecucion: comprueba la URL y aplica las migraciones con
 * `prisma migrate deploy` (las mismas que en produccion, sin reset).
 * DATABASE_URL se sobrescribe solo para ese proceso: prisma.config.ts carga
 * .env con dotenv, que no pisa lo que ya viene en el entorno.
 */
export default function setup() {
  const url = requireTestDatabaseUrl();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
