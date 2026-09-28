/**
 * Salud del servicio (F-034) para /api/health: Postgres y el almacenamiento,
 * cada uno con un timeout corto para que un monitor no se quede colgado si
 * uno no responde. Solo dice si/no: ni hosts, ni mensajes de error (van al
 * log).
 */
import { prisma } from "@/lib/prisma";
import { storageReachable } from "@/lib/storage";

export type HealthStatus = { db: boolean; storage: boolean };

export const HEALTH_TIMEOUT_MS = 2_000;

/** Completo, para el monitor externo: Postgres y almacenamiento. */
export async function checkHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthStatus> {
  const [db, storage] = await Promise.all([databaseReachable(timeoutMs), storageReachable(timeoutMs)]);
  return { db, storage };
}

/**
 * Vida, para el health check de Coolify: el proceso responde y llega a
 * Postgres. Sin el almacenamiento: con el health check activo, Traefik deja
 * de enrutar a un contenedor «unhealthy», y una caida de Garage (compartido
 * entre dev y prod) tumbaria el dominio entero, /login incluido.
 */
export async function checkLiveness(timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ db: boolean }> {
  return { db: await databaseReachable(timeoutMs) };
}

async function databaseReachable(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([prisma.$queryRaw`SELECT 1`.then(() => true), timeout]);
  } catch (err) {
    console.warn(`[health] base de datos no disponible: ${err instanceof Error ? err.name : "Error"}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
