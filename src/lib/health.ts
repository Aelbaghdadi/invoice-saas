/**
 * Salud del servicio (F-034) para /api/health: Postgres y el almacenamiento,
 * cada uno con un timeout corto para que un monitor no se quede colgado si
 * uno no responde. Solo dice si/no: ni hosts, ni mensajes de error (van al
 * log).
 *
 * Una sola comprobacion de cada cosa en curso a la vez, y su resultado vale
 * HEALTH_CACHE_MS: asi las llamadas del monitor y de Coolify no lanzan cada
 * una su SELECT 1. Eso no impide que el pool se llene con la BD colgada: el
 * timeout solo deja de esperar, y el SELECT 1 sigue ocupando su conexion
 * hasta que Postgres o la red lo sueltan; pasada la cache, la siguiente
 * comprobacion lanza otro. Lo que acota la espera de las demas consultas es
 * connectionTimeoutMillis del pool (src/lib/prisma.ts).
 */
import { prisma } from "@/lib/prisma";
import { storageReachable } from "@/lib/storage";

export type HealthStatus = { db: boolean; storage: boolean };

export const HEALTH_TIMEOUT_MS = 2_000;
export const HEALTH_CACHE_MS = 1_500;

/** La promesa, o `onTimeout()` si tarda mas de `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fn` con una sola llamada en curso a la vez y el resultado guardado `ttlMs`.
 * Con reloj monotono: con Date.now, un ajuste de hora hacia atras (NTP)
 * dejaba el resultado guardado mientras durara el salto. Una edad negativa
 * (un reloj inyectado que retrocede) cuenta como caducado.
 */
export function singleFlight<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = () => performance.now()): (() => Promise<T>) & { reset: () => void } {
  let inFlight: Promise<T> | null = null;
  let cached: { at: number; value: T } | null = null;
  const check = () => {
    const age = cached ? now() - cached.at : -1;
    if (cached && age >= 0 && age < ttlMs) return Promise.resolve(cached.value);
    if (!inFlight) {
      inFlight = fn()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
  return Object.assign(check, { reset: () => { cached = null; } });
}

const databaseCheck = singleFlight(() => databaseReachable(HEALTH_TIMEOUT_MS), HEALTH_CACHE_MS);
const storageCheck = singleFlight(() => storageReachable(HEALTH_TIMEOUT_MS), HEALTH_CACHE_MS);

/** Olvida el resultado guardado (para los tests). */
export function resetHealthCache(): void {
  databaseCheck.reset();
  storageCheck.reset();
}

/** Completo, para el monitor externo: Postgres y almacenamiento. */
export async function checkHealth(): Promise<HealthStatus> {
  const [db, storage] = await Promise.all([databaseCheck(), storageCheck()]);
  return { db, storage };
}

/**
 * Vida, para el health check de Coolify: el proceso responde y llega a
 * Postgres. Sin el almacenamiento: con el health check activo, Traefik deja
 * de enrutar a un contenedor «unhealthy», y una caida de Garage (compartido
 * entre dev y prod) tumbaria el dominio entero, /login incluido.
 */
export async function checkLiveness(): Promise<{ db: boolean }> {
  return { db: await databaseCheck() };
}

async function databaseReachable(timeoutMs: number): Promise<boolean> {
  try {
    return await withTimeout(prisma.$queryRaw`SELECT 1`.then(() => true), timeoutMs, () => {
      console.warn(`[health] base de datos sin respuesta en ${timeoutMs} ms`);
      return false;
    });
  } catch (err) {
    console.warn(`[health] base de datos no disponible: ${err instanceof Error ? err.name : "Error"}`);
    return false;
  }
}
