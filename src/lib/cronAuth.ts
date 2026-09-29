import { timingSafeEqual } from "crypto";

/**
 * Comprobacion del secreto de los crons (cabecera `Authorization: Bearer
 * <CRON_SECRET>`), la misma para GET y POST. Sin CRON_SECRET configurado no
 * pasa nadie. Comparacion en tiempo constante.
 */
export function verifyCronSecret(header: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret || !header) return false;
  // Longitud en bytes, no en caracteres: una cabecera con «é» tiene los mismos
  // caracteres que el secreto pero mas bytes, y timingSafeEqual lanzaba un
  // RangeError (500 en vez de 401).
  const received = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
