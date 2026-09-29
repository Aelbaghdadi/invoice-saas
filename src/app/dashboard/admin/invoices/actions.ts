"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { appendAuditLogs, AUDIT_TRANSACTION_OPTIONS } from "@/lib/auditLog";
import { processInvoice } from "@/lib/processInvoice";
import { ocrErrorsToReprocessWhere } from "@/lib/invoiceListing";
import type { InvoiceStatus } from "@prisma/client";

// NOTE: bulkValidateInvoices se quito a proposito (2026-09-25). Validar de
// golpe facturas que nadie ha abierto se saltaba justo lo que la revision
// comprueba (cuadre, cuentas contables, recargo, bienes/servicios), y la
// lista ya no tiene seleccion multiple.

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

  // Mismo where con el que cuenta el boton del listado.
  const invoices = await prisma.invoice.findMany({
    where: ocrErrorsToReprocessWhere(firmId),
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
    // Mismo valor que el reproceso de una sola factura: es el que la
    // auditoria sabe traducir ("Subida (reprocesar)").
    newValue: "UPLOADED (reprocess)",
  }));

  // Cambios, historial y auditoria en una transaccion (F-048): antes la
  // auditoria iba aparte y, si fallaba, las facturas ya estaban en UPLOADED
  // sin rastro de quien las relanzo.
  await prisma.$transaction(async (tx) => {
    await tx.invoice.updateMany({
      where: { id: { in: invoices.map((inv) => inv.id) } },
      data: { status: "UPLOADED", lastOcrError: null },
    });
    await tx.invoiceStatusHistory.createMany({
      data: invoices.map((inv) => ({
        invoiceId: inv.id,
        fromStatus: inv.status as InvoiceStatus,
        toStatus: "UPLOADED" as InvoiceStatus,
        changedBy: userId,
        reason: "Reprocesado masivo de Error OCR",
      })),
    });
    await appendAuditLogs(auditEntries, tx);
  }, AUDIT_TRANSACTION_OPTIONS);

  const invoiceIds = invoices.map((i) => i.id);

  after(async () => {
    for (const id of invoiceIds) {
      await processInvoice(id, userId).catch(() => {});
    }
  });

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoiceIds.length };
}
