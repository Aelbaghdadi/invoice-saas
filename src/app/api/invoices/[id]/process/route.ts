import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
import type { InvoiceStatus } from "@prisma/client";

/** Allowed statuses for (re)processing */
const PROCESSABLE_STATUSES = ["UPLOADED", "OCR_ERROR", "ANALYZED"] as const;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Workers can only reprocess invoices of their assigned clients
  if (session.user.role === "WORKER") {
    const assignment = await prisma.workerClientAssignment.findUnique({
      where: { workerId_clientId: { workerId: userId, clientId: invoice.clientId } },
    });
    if (!assignment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  if (!PROCESSABLE_STATUSES.includes(invoice.status as typeof PROCESSABLE_STATUSES[number])) {
    return NextResponse.json(
      { error: `Cannot process invoice in status ${invoice.status}` },
      { status: 400 },
    );
  }

  const isReprocess = invoice.status !== "UPLOADED";

  if (isReprocess) {
    const previousStatus = invoice.status;

    // Reset status to UPLOADED so processInvoice can pick it up.
    // Do NOT clear existing invoice fields — processInvoice will overwrite
    // them after successful OCR.
    await prisma.invoice.update({
      where: { id },
      data: { status: "UPLOADED", lastOcrError: null },
    });

    // Audit log for the reprocess action
    await prisma.auditLog.create({
      data: {
        invoiceId: id,
        userId,
        field: "status",
        oldValue: previousStatus,
        newValue: "UPLOADED (reprocess)",
      },
    });

    // Status history for the reset
    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: id,
        fromStatus: previousStatus as InvoiceStatus,
        toStatus: "UPLOADED",
        changedBy: userId,
        reason: "Manual reprocess requested",
      },
    });
  }

  // processInvoice atomically transitions UPLOADED -> ANALYZING -> ANALYZED/OCR_ERROR
  await processInvoice(id, userId);

  const updated = await prisma.invoice.findUnique({ where: { id } });
  return NextResponse.json({ success: true, invoice: updated });
}
