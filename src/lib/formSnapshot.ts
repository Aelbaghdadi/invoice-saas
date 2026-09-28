/**
 * Instantanea de un formulario para saber si tiene cambios sin guardar
 * (F-047). Se compara lo que se enviaria al guardar con lo que habia antes
 * de que el gestor tocara nada: si son iguales, no hay nada que perder.
 *
 * El orden de los campos no importa y un campo repetido cuenta con todos sus
 * valores. Los ficheros no se comparan (no hay en la revision).
 */
export function formSnapshot(fd: FormData, ignore: readonly string[] = []): string {
  const entries: [string, string][] = [];
  for (const [key, value] of fd.entries()) {
    if (ignore.includes(key) || typeof value !== "string") continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return JSON.stringify(entries);
}
