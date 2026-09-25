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

const FECHA_HORA = new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Fecha y hora de un momento concreto (subida, exportacion, cierre):
 * "25/09/2026 10:42", en hora de Madrid. A diferencia de formatDateEs, que
 * es para fechas de calendario (la de la factura), aqui importa la hora local:
 * una exportacion a las 00:30 es de ese dia, no del anterior en UTC.
 */
export function formatDateTimeEs(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return FECHA_HORA.format(d).replace(",", "");
}
