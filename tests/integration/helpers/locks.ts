import { prisma } from "./db";
import { registerLock } from "./inflight";

/**
 * Abre una transaccion que ejecuta `sql` (un LOCK TABLE, un SELECT … FOR
 * UPDATE) y la deja abierta hasta release(), que hace COMMIT. Sirve para
 * parar una accion en mitad de su escritura y cruzarle otra.
 *
 * Va por otra conexion del pool de Prisma, asi que las consultas del test y
 * de la app siguen funcionando mientras tanto. release() es idempotente y,
 * si el test falla antes de llamarlo, lo llama el setup al terminar el test.
 * La transaccion caduca a los 20 s (menos que el testTimeout) por si acaso.
 */
export async function holdLock(sql: string, ...params: unknown[]) {
  let resolveRelease!: (lastSql?: string) => void;
  const released = new Promise<string | undefined>((resolve) => (resolveRelease = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const transaction = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(sql, ...params);
    locked();
    const lastSql = await released;
    if (lastSql) await tx.$executeRawUnsafe(lastSql, ...params);
  }, { timeout: 20_000, maxWait: 10_000 });
  await Promise.race([isLocked, transaction]);

  let done: Promise<void> | null = null;
  const release = (lastSql?: string) => {
    done ??= (async () => {
      resolveRelease(lastSql);
      await transaction;
    })();
    return done;
  };
  const unregister = registerLock(() => release());
  return {
    /** COMMIT: suelta el bloqueo. `lastSql` (con los mismos parametros) se ejecuta justo antes, con el bloqueo aun puesto. */
    release: async (lastSql?: string) => {
      unregister();
      await release(lastSql);
    },
  };
}

/** Cuantas sesiones estan esperando un bloqueo ahora mismo. */
export async function sessionsWaitingForLock(): Promise<number> {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
  return Number(n);
}
