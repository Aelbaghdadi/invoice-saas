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

  const stuckInvoices = await prisma.invoice.findMany({
    where: {
      status: "UPLOADED",
      createdAt: { lt: fiveMinutesAgo },
      ocrAttempts: { lt: 3 },
    },
    select: { id: true },
  });

  for (const invoice of stuckInvoices) {
    await processInvoice(invoice.id, "system");
  }

  return NextResponse.json({ retried: stuckInvoices.length });
}
