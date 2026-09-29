import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/** Conexiones del pool de la app, como mucho (F-080). */
export const DB_POOL_MAX = 20;
/** Tope de cada consulta, en ms (F-080). */
export const DB_STATEMENT_TIMEOUT_MS = 15_000;

function createPrismaClient() {
  // Sin limite, con la BD colgada (o el pool lleno de consultas colgadas)
  // cada peticion esperaba una conexion para siempre. pg aplica este tiempo
  // tanto a abrir la conexion como a esperar turno en la cola del pool.
  //
  // F-080: como mucho DB_POOL_MAX conexiones por proceso (el Postgres de
  // Coolify admite 100 en total, ver DEPLOY §2 bis), y ninguna consulta pasa
  // de DB_STATEMENT_TIMEOUT_MS: una colgada ya no retiene su conexion para
  // siempre. Ninguna consulta de la app se acerca (medido con la suite de
  // integracion, exportaciones y el reset de la demo incluidos); si alguna lo
  // necesitara, que lo suba con SET LOCAL statement_timeout en su transaccion.
  // `migrate deploy` no usa este pool.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
    max: DB_POOL_MAX,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  });
  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
