import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
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
      ocrAttempts: { lt: 3 },
    },
    select: { id: true },
  });

  // ANALYZING facturas atascadas (OCR cayó o timeout silencioso): resetear a UPLOADED
  const analyzingStuck = await prisma.invoice.findMany({
    where: {
      status: "ANALYZING",
      updatedAt: { lt: fiveMinutesAgo },
      ocrAttempts: { lt: 3 },
    },
    select: { id: true },
  });

  if (analyzingStuck.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: analyzingStuck.map((i) => i.id) } },
      data: { status: "UPLOADED", lastOcrError: "Reset por cron (atascada en ANALYZING)" },
    });
  }

  const toRetry = [...uploadedStuck, ...analyzingStuck];
  for (const invoice of toRetry) {
    await processInvoice(invoice.id, "system");
  }

  return NextResponse.json({
    retried: toRetry.length,
    uploaded: uploadedStuck.length,
    resetFromAnalyzing: analyzingStuck.length,
  });
}
