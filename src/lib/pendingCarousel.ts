/**
 * La siguiente factura del carrusel «Clasificar de una en una» tras resolver
 * `doneId`: la primera pendiente detrás de ella y, si no queda ninguna detrás,
 * la primera desde el principio. Por id, no por posición: al clasificar, la
 * lista se recarga sin la clasificada y una posición apuntaba a otra factura.
 */
export function nextPendingId(
  rows: readonly { id: string }[],
  done: ReadonlySet<string>,
  doneId: string,
): string | null {
  const pending = (r: { id: string }) => r.id !== doneId && !done.has(r.id);
  const from = rows.findIndex((r) => r.id === doneId);
  return (rows.slice(from + 1).find(pending) ?? rows.slice(0, Math.max(from, 0)).find(pending))?.id ?? null;
}
