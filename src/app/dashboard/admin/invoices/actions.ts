"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { appendAuditLogs } from "@/lib/auditLog";
import { processInvoice } from "@/lib/processInvoice";
import type { InvoiceStatus } from "@prisma/client";

export async function bulkValidateInvoices(ids: string[]) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" };
  }
  if (ids.length === 0) return { error: "No hay facturas seleccionadas" };

  // Only allow bulk validation of invoices that have been reviewed
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids }, status: { in: ["PENDING_REVIEW", "NEEDS_ATTENTION"] } },
  });

  if (invoices.length === 0) {
    return { error: "Ninguna factura seleccionada puede ser validada (deben estar revisadas)" };
  }

  const userId = session.user.id;

  // Update each invoice individually to create proper history
  for (const inv of invoices) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: "VALIDATED" },
    });

    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: inv.id,
        fromStatus: inv.status,
        toStatus: "VALIDATED",
        changedBy: userId,
        reason: "Validación masiva por admin",
      },
    });

    await appendAuditLogs([{
      invoiceId: inv.id,
      userId,
      field: "status",
      oldValue: inv.status,
      newValue: "VALIDATED",
    }]);
  }

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoices.length };
}

// NOTE: bulkExportInvoices was removed intentionally.
// EXPORTED state should only be set via a real ExportBatch (export route),
// never by manual bulk action, to preserve traceability.

/**
 * Reprocesa de golpe TODAS las facturas en Error OCR de la asesoria del
 * admin logueado (no depende de seleccion manual ni de paginacion, para
 * no obligar a pasar pagina por pagina con decenas de facturas).
 *
 * El reset a UPLOADED + rastro de auditoria/historial se hace en
 * sincrono (es rapido, solo escritura en BD). El reprocesado real
 * (llamadas a Document AI/Gemini) se lanza en `after()` y de forma
 * SECUENCIAL -- no en paralelo -- para no saturar la cuota del
 * proveedor de OCR con decenas de llamadas simultaneas.
 */
export async function reprocessAllOcrErrors() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" };
  }

  const firmId = session.user.advisoryFirmId ?? undefined;
  const userId = session.user.id;

  const invoices = await prisma.invoice.findMany({
    where: {
      status: "OCR_ERROR",
      client: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    },
    select: { id: true, status: true },
  });

  if (invoices.length === 0) {
    return { error: "No hay facturas en Error OCR" };
  }

  const auditEntries = invoices.map((inv) => ({
    invoiceId: inv.id,
    userId,
    field: "status",
    oldValue: inv.status,
    newValue: "UPLOADED (reprocess masivo)",
  }));

  for (const inv of invoices) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: "UPLOADED", lastOcrError: null },
    });

    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: inv.id,
        fromStatus: inv.status as InvoiceStatus,
        toStatus: "UPLOADED",
        changedBy: userId,
        reason: "Reprocesado masivo de Error OCR",
      },
    });
  }

  await appendAuditLogs(auditEntries);

  const invoiceIds = invoices.map((i) => i.id);

  after(async () => {
    for (const id of invoiceIds) {
      await processInvoice(id, userId).catch(() => {});
    }
  });

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoiceIds.length };
}
