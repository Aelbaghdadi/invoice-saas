/**
 * Formateo de fechas para la UI (español).
 */

/**
 * Devuelve una fecha en formato español dd/mm/aaaa.
 *
 * Usa los componentes UTC (no la zona horaria del servidor) a propósito: las
 * fechas se guardan en UTC y hasta ahora se mostraban con
 * `toISOString().slice(0, 10)`, que también es UTC. Así el día mostrado no
 * cambia según dónde corra el contenedor. Para valores nulos/ inválidos
 * devuelve "—".
 */
export function formatDateEs(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
