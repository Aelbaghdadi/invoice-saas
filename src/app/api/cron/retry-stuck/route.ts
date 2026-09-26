import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
import { resolveCronOcrActor } from "@/lib/cronActor";
import {
  MAX_OCR_RETRIES,
  OCR_RETRIES_EXHAUSTED_ERROR,
  exhaustedAnalyzingWhere,
  stuckAnalyzingCutoff,
  stuckAnalyzingWhere,
} from "@/lib/invoiceStatuses";
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

  const fiveMinutesAgo = stuckAnalyzingCutoff();

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

  // Paradas que ya agotaron los reintentos: sin esto se quedaban en ANALYZING
  // para siempre y la revision no dejaba hacer nada con ellas. En OCR_ERROR
  // sale su Reprocesar y se pueden rellenar a mano. Una a una para dejar su
  // historial solo si el UPDATE condicionado la ha cambiado de verdad.
  const exhausted = await prisma.invoice.findMany({
    where: exhaustedAnalyzingWhere(fiveMinutesAgo),
    select: { id: true, ocrAttempts: true },
  });
  let exhaustedCount = 0;
  for (const { id, ocrAttempts } of exhausted) {
    const moved = await prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.updateMany({
        where: { id, ...exhaustedAnalyzingWhere(fiveMinutesAgo) },
        data: { status: "OCR_ERROR", lastOcrError: OCR_RETRIES_EXHAUSTED_ERROR },
      });
      if (updated.count === 0) return false;
      await tx.invoiceStatusHistory.create({
        data: {
          invoiceId: id,
          fromStatus: "ANALYZING",
          toStatus: "OCR_ERROR",
          changedBy: "system",
          // ocrAttempts cuenta todos los analisis de la factura, tambien los
          // Reprocesar manuales: la cifra real, no el maximo del cron. Si
          // cambiara, seria por un claim nuevo, que tambien mueve updatedAt y
          // el updateMany de arriba no la habria tocado.
          reason: `${OCR_RETRIES_EXHAUSTED_ERROR} (${ocrAttempts} análisis; ya no se reintenta sola: pulsa Reprocesar)`,
        },
      });
      return true;
    });
    if (moved) exhaustedCount += 1;
  }

  // processInvoice solo arranca las que siguen en UPLOADED (claim atomico):
  // las que no se resetearon se saltan solas.
  const toRetry = [...uploadedStuck, ...analyzingStuck];
  let skippedNoActor = 0;
  for (const invoice of toRetry) {
    // Un usuario real: con "system" la auditoria (FK a User) tumbaba la
    // transaccion del final del OCR y se perdia el resultado entero.
    const actorId = await resolveCronOcrActor(invoice.id);
    if (!actorId) {
      skippedNoActor += 1;
      console.warn(`[cron/retry-stuck] ${invoice.id}: sin usuario al que atribuir el OCR (ni quien la subio ni un ADMIN de la asesoria); no se relanza`);
      continue;
    }
    await processInvoice(invoice.id, actorId);
  }

  return NextResponse.json({
    retried: toRetry.length - skippedNoActor,
    skippedNoActor,
    uploaded: uploadedStuck.length,
    resetFromAnalyzing: reset.count,
    exhausted: exhaustedCount,
  });
}
