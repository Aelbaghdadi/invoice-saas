import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
import { MAX_OCR_RETRIES, stuckAnalyzingWhere } from "@/lib/invoiceStatuses";
import { timingSafeEqual } from "crypto";

function verifyCronSecret(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export async function GET(req: Request) {
  if (!verifyCronSecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  // UPLOADED facturas que nunca arrancaron
  const uploadedStuck = await prisma.invoice.findMany({
    where: {
      status: "UPLOADED",
      createdAt: { lt: fiveMinutesAgo },
      ocrAttempts: { lt: MAX_OCR_RETRIES },
    },
    select: { id: true },
  });

  // ANALYZING facturas atascadas (OCR cayó o timeout silencioso): resetear a UPLOADED
  const analyzingStuck = await prisma.invoice.findMany({
    where: stuckAnalyzingWhere(fiveMinutesAgo),
    select: { id: true },
  });

  // La misma condicion en el propio UPDATE: si el OCR termino entre la
  // lectura y esta escritura, la factura ya no esta en ANALYZING y no se
  // devuelve a UPLOADED. El claim de processInvoice sube ocrAttempts, asi que
  // la ejecucion colgada, si despierta, ya no puede escribir (F-008).
  const reset = analyzingStuck.length > 0
    ? await prisma.invoice.updateMany({
        where: { id: { in: analyzingStuck.map((i) => i.id) }, ...stuckAnalyzingWhere(fiveMinutesAgo) },
        data: { status: "UPLOADED", lastOcrError: "Reset por cron (atascada en ANALYZING)" },
      })
    : { count: 0 };

  // processInvoice solo arranca las que siguen en UPLOADED (claim atomico):
  // las que no se resetearon se saltan solas.
  const toRetry = [...uploadedStuck, ...analyzingStuck];
  for (const invoice of toRetry) {
    await processInvoice(invoice.id, "system");
  }

  return NextResponse.json({
    retried: toRetry.length,
    uploaded: uploadedStuck.length,
    resetFromAnalyzing: reset.count,
  });
}
