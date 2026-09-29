import { prisma } from "@/lib/prisma";
import { startOfDayInMadrid, yearMonthInMadrid } from "@/lib/dates";

/**
 * Informe de uso de una asesoria por mes (F-043), con lo que ya hay en la BD:
 * sin columnas nuevas, sin limites ni planes. Meses de Madrid.
 *
 * - Subidas: facturas creadas, sin las hijas de una division (salen de un
 *   fichero ya subido).
 * - Analisis de OCR: InvoiceExtraction de Gemini o Document AI (los XML de
 *   Facturae se leen sin OCR y van aparte), mas los que acabaron en «Error
 *   OCR» (historial ANALYZING → OCR_ERROR). Los reintentos dentro de un mismo
 *   analisis (429, 5xx) no se guardan en ningun sitio: no se pueden contar.
 * - Validadas: facturas distintas que pasaron a VALIDATED ese mes.
 * - Exportadas: facturas distintas que salieron en algun lote ese mes.
 * - Clientes y usuarios: los que existian a fin de mes (no hay bajas: un
 *   borrado no deja rastro).
 */

export type UsageMonth = {
  /** «2026-09». */
  month: string;
  uploaded: number;
  ocrAnalyses: number;
  ocrReprocesses: number;
  ocrFailures: number;
  xmlParsed: number;
  validated: number;
  exported: number;
  clients: number;
  staffUsers: number;
  portalUsers: number;
};

/** Los `count` meses que acaban en el actual (Madrid), del mas reciente al mas antiguo. */
export function usageMonths(now: Date, count: number): string[] {
  const { year, month } = yearMonthInMadrid(now);
  const index = year * 12 + (month - 1);
  return Array.from({ length: count }, (_, i) => {
    const m = index - i;
    return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
  });
}

/** Las 00:00 (Madrid) del primer dia del mes siguiente a «2026-09». */
function nextMonthStart(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? startOfDayInMadrid(y + 1, 1, 1) : startOfDayInMadrid(y, m + 1, 1);
}

type Counted = { month: string; n: number };

export async function usageReport(firmId: string, now = new Date(), count = 12): Promise<UsageMonth[]> {
  const months = usageMonths(now, count);
  const from = `${months[months.length - 1]}-01 00:00:00`;
  // Hora de Madrid de una columna timestamp guardada en UTC.
  const [uploads, ocr, failures, validated, exported, clients, staff, portal] = await Promise.all([
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(i."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(*)::int AS n
      FROM "Invoice" i JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND i."splitFromId" IS NULL
        AND i."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' >= ${from}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<{ month: string; ocr: number; reprocess: number; xml: number }[]>`
      SELECT to_char(e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month,
        (count(*) FILTER (WHERE e.source IN ('gemini_multimodal', 'document_ai')))::int AS ocr,
        (count(*) FILTER (WHERE e.source IN ('gemini_multimodal', 'document_ai') AND e."isReprocess"))::int AS reprocess,
        (count(*) FILTER (WHERE e.source = 'xml_parse'))::int AS xml
      FROM "InvoiceExtraction" e JOIN "Invoice" i ON i.id = e."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId}
        AND e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' >= ${from}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(*)::int AS n
      FROM "InvoiceStatusHistory" h JOIN "Invoice" i ON i.id = h."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND h."fromStatus" = 'ANALYZING' AND h."toStatus" = 'OCR_ERROR'
        AND h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' >= ${from}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(DISTINCT h."invoiceId")::int AS n
      FROM "InvoiceStatusHistory" h JOIN "Invoice" i ON i.id = h."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND h."toStatus" = 'VALIDATED'
        AND h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' >= ${from}::timestamp
      GROUP BY 1`,
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(x."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(DISTINCT x."invoiceId")::int AS n
      FROM "ExportBatchItem" x JOIN "Invoice" i ON i.id = x."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId}
        AND x."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid' >= ${from}::timestamp
      GROUP BY 1`,
    prisma.client.findMany({ where: { advisoryFirmId: firmId, isUnclassifiedBucket: false }, select: { createdAt: true } }),
    prisma.user.findMany({ where: { advisoryFirmId: firmId, role: { in: ["ADMIN", "WORKER"] } }, select: { createdAt: true } }),
    prisma.user.findMany({ where: { role: "CLIENT", clientProfile: { advisoryFirmId: firmId } }, select: { createdAt: true } }),
  ]);

  const byMonth = (rows: Counted[]) => new Map(rows.map((r) => [r.month, r.n]));
  const up = byMonth(uploads);
  const ocrBy = new Map(ocr.map((r) => [r.month, r]));
  const fail = byMonth(failures);
  const val = byMonth(validated);
  const exp = byMonth(exported);
  // Existentes a fin de mes: creados antes de que empiece el siguiente (en Madrid).
  const existingAt = (rows: { createdAt: Date }[], month: string) => {
    const end = nextMonthStart(month);
    return rows.filter((r) => r.createdAt < end).length;
  };

  return months.map((month) => ({
    month,
    uploaded: up.get(month) ?? 0,
    ocrAnalyses: (ocrBy.get(month)?.ocr ?? 0) + (fail.get(month) ?? 0),
    ocrReprocesses: ocrBy.get(month)?.reprocess ?? 0,
    ocrFailures: fail.get(month) ?? 0,
    xmlParsed: ocrBy.get(month)?.xml ?? 0,
    validated: val.get(month) ?? 0,
    exported: exp.get(month) ?? 0,
    clients: existingAt(clients, month),
    staffUsers: existingAt(staff, month),
    portalUsers: existingAt(portal, month),
  }));
}
