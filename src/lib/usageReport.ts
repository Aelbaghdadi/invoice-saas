import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { startOfDayInMadrid, yearMonthInMadrid } from "@/lib/dates";

/**
 * Informe de uso de una asesoria por mes (F-043), con lo que ya hay en la BD:
 * sin columnas nuevas, sin limites ni planes. Meses de Madrid.
 *
 * - Subidas: facturas creadas, sin las hijas de una division (salen de un
 *   fichero ya subido).
 * - Analisis de OCR: InvoiceExtraction que no son de un XML (Gemini por
 *   texto o por imagen, Document AI; los XML de Facturae se leen sin OCR y
 *   van aparte), mas los que acabaron en «Error
 *   OCR» (historial ANALYZING → OCR_ERROR), sin los XML ni los que no
 *   pudieron descargar el original (ERR-OCR-004), que no llegaron al
 *   proveedor. Un 500 de Garage no se distingue de un fallo del proveedor
 *   (los dos son ERR-OCR-001). Los reintentos dentro de un mismo
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
  // El inicio de la ventana en UTC, como las columnas (timestamp sin zona):
  // el filtro va sobre la constante y no envuelve la columna, que asi puede
  // usar un indice (revision 1 del PR #15, punto 17). La hora de Madrid solo
  // se calcula para agrupar por mes.
  const fromUtc = Prisma.sql`((${from}::timestamp AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'UTC')`;
  const [uploads, ocr, failures, validated, exported, clients, staff, portal] = await Promise.all([
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(i."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(*)::int AS n
      FROM "Invoice" i JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND i."splitFromId" IS NULL
        AND i."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.$queryRaw<{ month: string; ocr: number; reprocess: number; xml: number }[]>`
      SELECT to_char(e."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month,
        (count(*) FILTER (WHERE e.source <> 'xml_parse'))::int AS ocr,
        (count(*) FILTER (WHERE e.source <> 'xml_parse' AND e."isReprocess"))::int AS reprocess,
        (count(*) FILTER (WHERE e.source = 'xml_parse'))::int AS xml
      FROM "InvoiceExtraction" e JOIN "Invoice" i ON i.id = e."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId}
        AND e."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    // Un fallo es un reproceso si la factura ya habia terminado otro analisis
    // antes (lo mismo que isReprocess de una extraccion: no era el primero).
    prisma.$queryRaw<{ month: string; n: number; reprocess: number }[]>`
      SELECT to_char(h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(*)::int AS n,
        (count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "InvoiceStatusHistory" p
          WHERE p."invoiceId" = h."invoiceId" AND p."fromStatus" = 'ANALYZING' AND p."createdAt" < h."createdAt"
        )))::int AS reprocess
      FROM "InvoiceStatusHistory" h JOIN "Invoice" i ON i.id = h."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND h."fromStatus" = 'ANALYZING' AND h."toStatus" = 'OCR_ERROR'
        -- Sin llegar al proveedor: un XML (se lee sin OCR) o el original que
        -- no se pudo descargar (ERR-OCR-004).
        AND i."fileType" NOT IN ('application/xml', 'text/xml')
        AND coalesce(h.reason, '') NOT LIKE '[ERR-OCR-004]%'
        AND h."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(h."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(DISTINCT h."invoiceId")::int AS n
      FROM "InvoiceStatusHistory" h JOIN "Invoice" i ON i.id = h."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId} AND h."toStatus" = 'VALIDATED'
        AND h."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.$queryRaw<Counted[]>`
      SELECT to_char(x."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Madrid', 'YYYY-MM') AS month, count(DISTINCT x."invoiceId")::int AS n
      FROM "ExportBatchItem" x JOIN "Invoice" i ON i.id = x."invoiceId" JOIN "Client" c ON c.id = i."clientId"
      WHERE c."advisoryFirmId" = ${firmId}
        AND x."createdAt" >= ${fromUtc}
      GROUP BY 1`,
    prisma.client.findMany({ where: { advisoryFirmId: firmId, isUnclassifiedBucket: false }, select: { createdAt: true } }),
    prisma.user.findMany({ where: { advisoryFirmId: firmId, role: { in: ["ADMIN", "WORKER"] } }, select: { createdAt: true } }),
    prisma.user.findMany({ where: { role: "CLIENT", clientProfile: { advisoryFirmId: firmId } }, select: { createdAt: true } }),
  ]);

  const byMonth = (rows: Counted[]) => new Map(rows.map((r) => [r.month, r.n]));
  const up = byMonth(uploads);
  const ocrBy = new Map(ocr.map((r) => [r.month, r]));
  const fail = byMonth(failures);
  const failedReprocess = new Map(failures.map((r) => [r.month, r.reprocess]));
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
    ocrReprocesses: (ocrBy.get(month)?.reprocess ?? 0) + (failedReprocess.get(month) ?? 0),
    ocrFailures: fail.get(month) ?? 0,
    xmlParsed: ocrBy.get(month)?.xml ?? 0,
    validated: val.get(month) ?? 0,
    exported: exp.get(month) ?? 0,
    clients: existingAt(clients, month),
    staffUsers: existingAt(staff, month),
    portalUsers: existingAt(portal, month),
  }));
}
