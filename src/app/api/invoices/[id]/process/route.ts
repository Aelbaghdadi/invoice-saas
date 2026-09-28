import { after, NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { processInvoice } from "@/lib/processInvoice";
import { appendAuditLogs } from "@/lib/auditLog";
import { ERROR_MESSAGES } from "@/lib/errorCodes";
import { STATUS_LABELS, manualStuckAnalyzingWhere, stuckAnalyzingCutoff } from "@/lib/invoiceStatuses";
import type { InvoiceStatus } from "@prisma/client";

/**
 * El analisis, fuera de la peticion y delante de la cola del OCR (revision 1
 * del PR #14, punto 3): con la cola llena, esperar aqui dejaba el boton
 * girando minutos. La respuesta sale con la factura en UPLOADED y la
 * revision la sigue con su aviso de «Analizando».
 */
function launch(id: string, userId: string) {
  after(() => processInvoice(id, userId, { priority: true }).catch((err) => {
    console.error(`[processInvoice] ${id} fallo:`, err);
  }));
}

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

  // Parada en ANALYZING (un redeploy o un OOM mataron el OCR): se devuelve a
  // UPLOADED con el mismo corte que el cron y sin limite de intentos. Si el
  // OCR colgado despierta, ya no escribe: el claim nuevo sube ocrAttempts.
  if (invoice.status === "ANALYZING") {
    const stalled = await prisma.invoice.updateMany({
      where: manualStuckAnalyzingWhere(id, stuckAnalyzingCutoff()),
      data: { status: "UPLOADED", lastOcrError: null },
    });
    if (stalled.count === 0) {
      return NextResponse.json(
        { error: "La factura ya se está analizando. Espera unos segundos y recarga la página." },
        { status: 400 },
      );
    }
    await appendAuditLogs([{
      invoiceId: id,
      userId,
      field: "status",
      oldValue: "ANALYZING",
      newValue: "UPLOADED (reprocess)",
    }]);
    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: id,
        fromStatus: "ANALYZING",
        toStatus: "UPLOADED",
        changedBy: userId,
        reason: "Reprocesado manualmente (el análisis se había parado)",
      },
    });
    launch(id, userId);
    const updated = await prisma.invoice.findUnique({ where: { id } });
    return NextResponse.json({ success: true, invoice: updated });
  }

  if (!PROCESSABLE_STATUSES.includes(invoice.status as typeof PROCESSABLE_STATUSES[number])) {
    return NextResponse.json(
      { error: `No se puede reprocesar: la factura está «${STATUS_LABELS[invoice.status]}».` },
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

  launch(id, userId);

  const updated = await prisma.invoice.findUnique({ where: { id } });
  return NextResponse.json({ success: true, invoice: updated });
}
