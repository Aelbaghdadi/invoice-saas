/**
 * after() de next/server simulado: las acciones encolan el trabajo y el test
 * decide cuando ejecutarlo (runAfterCallbacks) o si descartarlo.
 */
type Callback = () => unknown | Promise<unknown>;
const queue: Callback[] = [];

export function enqueueAfter(callback: Callback | Promise<unknown>) {
  if (typeof callback === "function") queue.push(callback);
}

export async function runAfterCallbacks() {
  while (queue.length > 0) await queue.shift()!();
}

export function discardAfterCallbacks() {
  queue.length = 0;
}
