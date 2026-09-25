import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { processInvoice } from "@/lib/processInvoice";
import { appendAuditLogs } from "@/lib/auditLog";
import { ERROR_MESSAGES } from "@/lib/errorCodes";
import { STATUS_LABELS } from "@/lib/invoiceStatuses";
import type { InvoiceStatus } from "@prisma/client";

/** Allowed statuses for (re)processing */
const PROCESSABLE_STATUSES = ["UPLOADED", "OCR_ERROR", "ANALYZED"] as const;

const NOT_FOUND = "Factura no encontrada o sin acceso.";

// Los errores van como texto plano: las tres pantallas que llaman aqui pintan
// `data.error` tal cual en un aviso.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: ERROR_MESSAGES["ERR-AUTH-001"] }, { status: 401 });
  }
  if (!["ADMIN", "WORKER"].includes(session.user.role)) {
    return NextResponse.json({ error: ERROR_MESSAGES["ERR-AUTH-002"] }, { status: 403 });
  }

  const { id } = await params;
  const userId = session.user.id;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }

  // WORKER: solo clientes asignados. ADMIN: solo clientes de su asesoria
  // (antes un ADMIN podia reprocesar la factura de otra asesoria).
  if (!(await canAccessClient(session, invoice.clientId))) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }

  if (!PROCESSABLE_STATUSES.includes(invoice.status as typeof PROCESSABLE_STATUSES[number])) {
    // ANALYZING es lo normal al pulsar Reprocesar dos veces seguidas.
    const error = invoice.status === "ANALYZING"
      ? "La factura ya se está analizando. Espera unos segundos y recarga la página."
      : `No se puede reprocesar: la factura está «${STATUS_LABELS[invoice.status]}».`;
    return NextResponse.json({ error }, { status: 400 });
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

    // Audit log for the reprocess action (cadena de hash)
    await appendAuditLogs([{
      invoiceId: id,
      userId,
      field: "status",
      oldValue: previousStatus,
      newValue: "UPLOADED (reprocess)",
    }]);

    // Status history for the reset
    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: id,
        fromStatus: previousStatus as InvoiceStatus,
        toStatus: "UPLOADED",
        changedBy: userId,
        reason: "Reprocesado manualmente",
      },
    });
  }

  // processInvoice atomically transitions UPLOADED -> ANALYZING -> ANALYZED/OCR_ERROR
  await processInvoice(id, userId);

  const updated = await prisma.invoice.findUnique({ where: { id } });
  return NextResponse.json({ success: true, invoice: updated });
}
