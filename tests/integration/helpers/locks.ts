import { prisma } from "./db";

/**
 * Abre una transaccion que ejecuta `sql` (un LOCK TABLE, un SELECT … FOR
 * UPDATE) y la deja abierta hasta release(), que hace COMMIT. Sirve para
 * parar una accion en mitad de su escritura y cruzarle otra.
 *
 * Va por otra conexion del pool de Prisma, asi que las consultas del test y
 * de la app siguen funcionando mientras tanto.
 */
export async function holdLock(sql: string) {
  let release!: (lastSql?: string) => void;
  const released = new Promise<string | undefined>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const transaction = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(sql);
    locked();
    const lastSql = await released;
    if (lastSql) await tx.$executeRawUnsafe(lastSql);
  }, { timeout: 120_000, maxWait: 10_000 });
  await Promise.race([isLocked, transaction]);
  return {
    /** COMMIT: suelta el bloqueo. `lastSql` se ejecuta justo antes, con el bloqueo aun puesto. */
    release: async (lastSql?: string) => {
      release(lastSql);
      await transaction;
    },
  };
}

/** Cuantas sesiones estan esperando un bloqueo ahora mismo. */
export async function sessionsWaitingForLock(): Promise<number> {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
  return Number(n);
}
