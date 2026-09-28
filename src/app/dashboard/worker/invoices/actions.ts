"use server";

import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { canAccessClient } from "@/lib/accessibleClients";
import { notifyRejection, rejectInvoiceCore } from "@/lib/invoiceRejection";
import { duplicateRejectionReason, findDuplicateOriginal } from "@/lib/duplicates";
import { REVIEWABLE } from "@/lib/invoiceStatuses";

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
 * Usa rejectionCategory=DUPLICATE y un motivo para el cliente que nombra la
 * factura original si la incidencia la guarda.
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

  // Motivo para el cliente (le llega por correo), con la original si la
  // incidencia la guarda. La descripcion de la incidencia es para el gestor.
  const dupIssue = await prisma.invoiceIssue.findFirst({
    where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN" },
    select: { field: true, invoice: { select: { clientId: true } } },
  });
  const original = dupIssue ? await findDuplicateOriginal(dupIssue.field, dupIssue.invoice.clientId) : null;
  const reason = duplicateRejectionReason(original);

  // El mismo flujo que rechazar desde la revision: exportada, estado,
  // periodo cerrado y escritura condicionada (F-057: cierra todas las
  // incidencias, no solo la del duplicado).
  const result = await rejectInvoiceCore({
    invoiceId,
    userId: session.user.id,
    reason,
    category: "DUPLICATE",
    // Solo por revisar: el listado puede llevar rato abierto y otro gestor
    // haberla validado (antes se deshacia su validacion).
    allowedFrom: { statuses: REVIEWABLE, error: "Esta factura ya no está por revisar. Recarga la página." },
    authorize: async (clientId) => (await canAccessClient(session, clientId)) ? null : { error: "No tienes acceso a esta factura." },
  });
  if ("error" in result) return { error: typeof result.error === "string" ? result.error : result.error.message };

  after(() => notifyRejection(invoiceId, reason));

  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/worker/issues");
  return { ok: true };
}

/**
 * Descartar incidencia POSSIBLE_DUPLICATE sin rechazar la factura ("no
 * es duplicado, son dos facturas distintas del mismo emisor con mismo
 * importe"). Baja a PENDING_REVIEW si no quedan otras incidencias. Desde el
 * listado (todas las de duplicado de la factura) y desde la revision («No es
 * duplicada», F-016: solo la de esa fila, con issueId).
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
  // Desde la revision llega la incidencia concreta: se descarta solo esa.
  // Desde el listado no: se descartan todas las de duplicado de la factura.
  const issueId = (formData.get("issueId") as string | null) || null;

  const access = await assertAccess(session, invoiceId);
  if (access) return access;

  // Incidencias, estado e historial juntos: si falla a medias no queda en
  // «Con incidencias» sin ninguna abierta.
  const dismissed = await prisma.$transaction(async (tx) => {
    const closed = await tx.invoiceIssue.updateMany({
      where: { invoiceId, type: "POSSIBLE_DUPLICATE", status: "OPEN", ...(issueId ? { id: issueId } : {}) },
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
