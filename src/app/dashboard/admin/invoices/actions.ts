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
    select: { id: true },
  });

  if (invoices.length === 0) {
    return { error: "No hay facturas en Error OCR" };
  }

  // Cambios, historial y auditoria en una transaccion (F-048), y solo de las
  // que siguen en Error OCR al escribir: entre la lectura y la escritura otro
  // puede haberla reprocesado o rechazado (revision 1 del PR #15, punto 8).
  let invoiceIds: string[];
  try {
    invoiceIds = await prisma.$transaction(async (tx) => {
      const changed: string[] = [];
      for (const inv of invoices) {
        const reset = await tx.invoice.updateMany({
          where: { id: inv.id, status: "OCR_ERROR" },
          data: { status: "UPLOADED", lastOcrError: null },
        });
        if (reset.count === 1) changed.push(inv.id);
      }
      await tx.invoiceStatusHistory.createMany({
        data: changed.map((invoiceId) => ({
          invoiceId,
          fromStatus: "OCR_ERROR" as InvoiceStatus,
          toStatus: "UPLOADED" as InvoiceStatus,
          changedBy: userId,
          reason: "Reprocesado masivo de Error OCR",
        })),
      });
      await appendAuditLogs(changed.map((invoiceId) => ({
        invoiceId,
        userId,
        field: "status",
        oldValue: "OCR_ERROR",
        // Mismo valor que el reproceso de una sola factura: es el que la
        // auditoria sabe traducir ("Subida (reprocesar)").
        newValue: "UPLOADED (reprocess)",
      })), tx);
      return changed;
    }, AUDIT_TRANSACTION_OPTIONS);
  } catch (err) {
    console.error("[reprocessAllOcrErrors]", err);
    return { error: "No se pudieron reprocesar las facturas. Inténtalo de nuevo." };
  }
  if (invoiceIds.length === 0) {
    return { error: "No hay facturas en Error OCR" };
  }

  after(async () => {
    for (const id of invoiceIds) {
      await processInvoice(id, userId).catch(() => {});
    }
  });

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoiceIds.length };
}
