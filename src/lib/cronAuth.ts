import { timingSafeEqual } from "crypto";

/**
 * Comprobacion del secreto de los crons (cabecera `Authorization: Bearer
 * <CRON_SECRET>`), la misma para GET y POST. Sin CRON_SECRET configurado no
 * pasa nadie. Comparacion en tiempo constante.
 */
export function verifyCronSecret(header: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
