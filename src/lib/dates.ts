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

const PARTES_MADRID = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function madridParts(d: Date): Record<string, string> {
  return Object.fromEntries(PARTES_MADRID.formatToParts(d).map((p) => [p.type, p.value]));
}

/**
 * Las 00:00 en Madrid de un dia de calendario (mes 1-12), como instante.
 * Madrid va a UTC+1 o UTC+2, asi que su medianoche cae a las 22:00 o a las
 * 23:00 UTC del dia anterior: se prueba la de verano y, si alli no son las
 * 00, es la de invierno. La medianoche nunca cae en el hueco del cambio de
 * hora (se cambia a las 02:00/03:00), asi que la prueba vale todo el ano.
 */
export function startOfDayInMadrid(year: number, month: number, day: number): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  const summer = new Date(utcMidnight - 2 * 3600_000);
  return madridParts(summer).hour === "00" ? summer : new Date(utcMidnight - 3600_000);
}

/** Las 00:00 de hoy en Madrid. Con el dia en UTC, de 00:00 a 02:00 se
 *  contaba el dia anterior. */
export function startOfTodayInMadrid(now = new Date()): Date {
  const today = madridParts(now);
  return startOfDayInMadrid(Number(today.year), Number(today.month), Number(today.day));
}

/**
 * Limites de un dia "AAAA-MM-DD" (el valor de un <input type="date">) en
 * hora de Madrid: [start, end), con end la medianoche del dia siguiente.
 * Sirve para filtrar por el mismo dia que se muestra con formatDateTimeEs.
 * Devuelve null si el texto no es una fecha valida.
 */
export function madridDayBounds(ymd: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC desborda (31/02 -> 03/03): se descarta en vez de filtrar otro dia.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: startOfDayInMadrid(year, month, day),
    end: startOfDayInMadrid(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}
