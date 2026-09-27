import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { requireTestDatabaseUrl } from "./guard";

/**
 * Una vez por ejecucion: comprueba la URL y aplica las migraciones con
 * `prisma migrate deploy` (las mismas que en produccion, sin reset).
 * DATABASE_URL se sobrescribe solo para ese proceso: prisma.config.ts carga
 * .env con dotenv, que no pisa lo que ya viene en el entorno.
 *
 * El CLI de Prisma se lanza con el propio node (process.execPath) y la ruta
 * de su bin: `npx` sin shell da ENOENT en Windows, y con shell la URL pasaria
 * por el interprete.
 */
function prismaCli(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("prisma/package.json");
  const bin = (require(pkg) as { bin: { prisma: string } }).bin.prisma;
  return path.join(path.dirname(pkg), bin);
}

export default function setup() {
  const url = requireTestDatabaseUrl();
  execFileSync(process.execPath, [prismaCli(), "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
