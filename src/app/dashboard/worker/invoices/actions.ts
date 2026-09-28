"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { notifyClientInvoiceRejected } from "@/lib/email";
import { appendAuditLogs } from "@/lib/auditLog";
import { closeOpenIssues } from "@/lib/invoiceIssues";
import { canAccessClient } from "@/lib/accessibleClients";

export type InvoiceQuickAction = { ok?: boolean; error?: string } | null;

/** WORKER: el cliente asignado. ADMIN: de su asesoria (antes cualquier ADMIN
 *  pasaba sin mirar la asesoria). */
async function assertAccess(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  invoiceId: string,
): Promise<{ error: string } | null> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { clientId: true },
  });
  if (!inv) return { error: "Factura no encontrada" };
  if (!(await canAccessClient(session, inv.clientId))) return { error: "No tienes acceso a esta factura." };
  return null;
}

/**
 * Rechazo rapido como duplicado desde el listado. No abre el modal: un
 * clic y listo, porque un duplicado no necesita revision.
 *
 * Usa rejectionCategory=DUPLICATE y un motivo autogenerado que incluye
 * el nombre del fichero duplicado original si se conoce.
 */
export async function quickRejectDuplicate(
  _prev: InvoiceQuickAction,
  formData: FormData,
): Promise<InvoiceQuickAction> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const invoiceId = formData.get("invoiceId") as string;
  if (!invoiceId) return { error: "ID no proporcionado" };

  const access = await assertAccess(session, invoiceId);
  if (access) return access;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "Factura no encontrada" };
  if (invoice.status === "REJECTED" || invoice.status === "VALIDATED") {
    return { error: "La factura ya está cerrada" };
  }

  // Construye motivo a partir del issue POSSIBLE_DUPLICATE si existe
  const dupIssue = await prisma.invoiceIssue.findFirst({
    where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN" },
  });
  const reason = dupIssue?.description ?? "Factura duplicada detectada desde el listado";

  // Estado, incidencias (F-057: todas, no solo la del duplicado), historial
  // y auditoria en una transaccion.
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        rejectionCategory: "DUPLICATE",
        reviewedBy: session.user.id,
      },
    });
    await closeOpenIssues(tx, invoiceId, session.user.id);
    await tx.invoiceStatusHistory.create({
      data: {
        invoiceId,
        fromStatus: invoice.status,
        toStatus: "REJECTED",
        changedBy: session.user.id,
        reason,
      },
    });
    await appendAuditLogs([{
      invoiceId,
      userId: session.user.id,
      field: "status",
      oldValue: invoice.status,
      newValue: "REJECTED",
    }], tx);
  });

  // Notificacion al cliente en background
  after(async () => {
    try {
      const inv = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { client: { include: { user: { select: { email: true } } } } },
      });
      if (inv?.client?.user?.email) {
        await notifyClientInvoiceRejected({
          clientEmail: inv.client.user.email,
          clientName: inv.client.name,
          invoiceNumber: inv.invoiceNumber ?? "",
          filename: inv.filename,
          reason,
        });
      }
    } catch (e) {
      console.error("[NOTIFY] quickRejectDuplicate:", e);
    }
  });

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/issues");
  return { ok: true };
}

/**
 * Descartar incidencia POSSIBLE_DUPLICATE sin rechazar la factura ("no
 * es duplicado, son dos facturas distintas del mismo emisor con mismo
 * importe"). Baja a PENDING_REVIEW si no quedan otras incidencias. Desde el
 * listado y desde la revision («No es duplicada», F-016).
 */
export async function dismissDuplicateIssue(
  _prev: InvoiceQuickAction,
  formData: FormData,
): Promise<InvoiceQuickAction> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const invoiceId = formData.get("invoiceId") as string;
  if (!invoiceId) return { error: "ID no proporcionado" };

  const access = await assertAccess(session, invoiceId);
  if (access) return access;

  // Incidencias, estado e historial juntos: si falla a medias no queda en
  // «Con incidencias» sin ninguna abierta.
  const dismissed = await prisma.$transaction(async (tx) => {
    const closed = await tx.invoiceIssue.updateMany({
      where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN" },
      data: {
        status: "DISMISSED",
        resolvedBy: session.user.id,
        resolvedAt: new Date(),
      },
    });
    if (closed.count === 0) return false;

    const remaining = await tx.invoiceIssue.count({
      where: { invoiceId, status: "OPEN" },
    });
    if (remaining === 0) {
      const lowered = await tx.invoice.updateMany({
        where: { id: invoiceId, status: "NEEDS_ATTENTION" },
        data: { status: "PENDING_REVIEW" },
      });
      if (lowered.count > 0) {
        await tx.invoiceStatusHistory.create({
          data: {
            invoiceId,
            fromStatus: "NEEDS_ATTENTION",
            toStatus: "PENDING_REVIEW",
            changedBy: session.user.id,
            reason: "Duplicado descartado por el gestor",
          },
        });
      }
    }
    return true;
  });
  if (!dismissed) return { error: "No hay incidencias de duplicado abiertas" };

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath(`/dashboard/worker/review/${invoiceId}`);
  return { ok: true };
}
