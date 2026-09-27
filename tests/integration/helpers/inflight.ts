/**
 * Lo que un test deja a medias: bloqueos abiertos (holdLock) y acciones
 * lanzadas sin await (las de las carreras). Si un test falla entre medias,
 * el setup lo cierra todo en afterEach, antes del TRUNCATE del siguiente:
 * primero suelta los bloqueos (las acciones estan esperando por ellos) y
 * luego espera a que terminen las acciones, para que una rezagada no escriba
 * en los datos del test siguiente.
 */
const pending = new Set<Promise<unknown>>();
const openLocks = new Set<() => Promise<void>>();

/** Registra una accion lanzada sin await. Devuelve la misma promesa. */
export function inFlight<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}

export function registerLock(release: () => Promise<void>) {
  openLocks.add(release);
  return () => openLocks.delete(release);
}

export async function settleInFlight() {
  for (const release of [...openLocks]) await release().catch(() => {});
  openLocks.clear();
  await Promise.allSettled([...pending]);
  pending.clear();
}
