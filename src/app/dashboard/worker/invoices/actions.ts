"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { notifyClientInvoiceRejected } from "@/lib/email";

export type InvoiceQuickAction = { ok?: boolean; error?: string } | null;

async function assertAccess(
  userId: string,
  role: string,
  invoiceId: string,
): Promise<{ error: string } | null> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { clientId: true },
  });
  if (!inv) return { error: "Factura no encontrada" };
  if (role === "ADMIN") return null;
  if (role !== "WORKER") return { error: "No autorizado" };
  const assignment = await prisma.workerClientAssignment.findUnique({
    where: { workerId_clientId: { workerId: userId, clientId: inv.clientId } },
  });
  if (!assignment) return { error: "No tienes acceso a esta factura." };
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

  const access = await assertAccess(session.user.id, session.user.role, invoiceId);
  if (access) return access;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "Factura no encontrada" };
  if (invoice.status === "REJECTED" || invoice.status === "VALIDATED") {
    return { error: "La factura ya esta cerrada" };
  }

  // Construye motivo a partir del issue POSSIBLE_DUPLICATE si existe
  const dupIssue = await prisma.invoiceIssue.findFirst({
    where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN" },
  });
  const reason = dupIssue?.description ?? "Factura duplicada detectada desde el listado";

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "REJECTED",
      rejectionReason: reason,
      rejectionCategory: "DUPLICATE",
      reviewedBy: session.user.id,
    },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId,
      fromStatus: invoice.status,
      toStatus: "REJECTED",
      changedBy: session.user.id,
      reason,
    },
  });

  // Cerrar el issue que motivo el rechazo
  if (dupIssue) {
    await prisma.invoiceIssue.update({
      where: { id: dupIssue.id },
      data: { status: "RESOLVED", resolvedBy: session.user.id, resolvedAt: new Date() },
    });
  }

  await prisma.auditLog.create({
    data: {
      invoiceId,
      userId: session.user.id,
      field: "status",
      oldValue: invoice.status,
      newValue: "REJECTED",
    },
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
 * importe"). Baja a PENDING_REVIEW si no quedan otras incidencias.
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

  const access = await assertAccess(session.user.id, session.user.role, invoiceId);
  if (access) return access;

  const issues = await prisma.invoiceIssue.findMany({
    where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN" },
  });
  if (issues.length === 0) return { error: "No hay incidencias de duplicado" };

  await prisma.invoiceIssue.updateMany({
    where: { id: { in: issues.map((i) => i.id) } },
    data: {
      status: "DISMISSED",
      resolvedBy: session.user.id,
      resolvedAt: new Date(),
    },
  });

  // Si no quedan issues abiertas y estaba en NEEDS_ATTENTION, baja a PENDING_REVIEW
  const remaining = await prisma.invoiceIssue.count({
    where: { invoiceId, status: "OPEN" },
  });
  if (remaining === 0) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (invoice?.status === "NEEDS_ATTENTION") {
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: "PENDING_REVIEW" },
      });
      await prisma.invoiceStatusHistory.create({
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

  revalidatePath("/dashboard/worker/invoices");
  return { ok: true };
}
