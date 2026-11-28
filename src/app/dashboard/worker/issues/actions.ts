"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { canAccessClient } from "@/lib/accessibleClients";

export type IssueActionState = { error?: string; success?: boolean } | null;

/** WORKER: el cliente asignado. ADMIN: de su asesoria. Antes el ADMIN pasaba
 *  sin mirarla y, con el id, cerraba la incidencia de otra asesoria y cambiaba
 *  el estado de su factura. */
async function assertAccess(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  invoiceId: string,
): Promise<IssueActionState> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { clientId: true },
  });
  if (!invoice) return { error: "Factura no encontrada" };
  if (!(await canAccessClient(session, invoice.clientId))) return { error: "No tienes acceso a esta factura." };
  return null;
}

export async function resolveIssue(
  _prev: IssueActionState,
  formData: FormData,
): Promise<IssueActionState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const issueId = formData.get("issueId") as string;
  if (!issueId) return { error: "ID de incidencia no proporcionado" };

  const issue = await prisma.invoiceIssue.findUnique({
    where: { id: issueId },
  });
  if (!issue) return { error: "Incidencia no encontrada" };
  if (issue.status !== "OPEN") return { error: "La incidencia ya está cerrada" };

  const accessErr = await assertAccess(session, issue.invoiceId);
  if (accessErr) return accessErr;

  await prisma.invoiceIssue.update({
    where: { id: issueId },
    data: {
      status: "RESOLVED",
      resolvedBy: session.user.id,
      resolvedAt: new Date(),
    },
  });

  // If all issues for this invoice are now resolved/dismissed, transition to PENDING_REVIEW
  const openIssues = await prisma.invoiceIssue.count({
    where: { invoiceId: issue.invoiceId, status: "OPEN" },
  });
  if (openIssues === 0) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: issue.invoiceId },
    });
    if (invoice?.status === "NEEDS_ATTENTION") {
      await prisma.invoice.update({
        where: { id: issue.invoiceId },
        data: { status: "PENDING_REVIEW" },
      });
      await prisma.invoiceStatusHistory.create({
        data: {
          invoiceId: issue.invoiceId,
          fromStatus: "NEEDS_ATTENTION",
          toStatus: "PENDING_REVIEW",
          changedBy: session.user.id,
          reason: "Todas las incidencias resueltas",
        },
      });
    }
  }

  revalidatePath("/dashboard/worker/issues");
  revalidatePath(`/dashboard/worker/review/${issue.invoiceId}`);
  return { success: true };
}

export async function dismissIssue(
  _prev: IssueActionState,
  formData: FormData,
): Promise<IssueActionState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const issueId = formData.get("issueId") as string;
  if (!issueId) return { error: "ID de incidencia no proporcionado" };

  const issue = await prisma.invoiceIssue.findUnique({
    where: { id: issueId },
  });
  if (!issue) return { error: "Incidencia no encontrada" };
  if (issue.status !== "OPEN") return { error: "La incidencia ya está cerrada" };

  const accessErr = await assertAccess(session, issue.invoiceId);
  if (accessErr) return accessErr;

  await prisma.invoiceIssue.update({
    where: { id: issueId },
    data: {
      status: "DISMISSED",
      resolvedBy: session.user.id,
      resolvedAt: new Date(),
    },
  });

  // Same auto-transition logic
  const openIssues = await prisma.invoiceIssue.count({
    where: { invoiceId: issue.invoiceId, status: "OPEN" },
  });
  if (openIssues === 0) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: issue.invoiceId },
    });
    if (invoice?.status === "NEEDS_ATTENTION") {
      await prisma.invoice.update({
        where: { id: issue.invoiceId },
        data: { status: "PENDING_REVIEW" },
      });
      await prisma.invoiceStatusHistory.create({
        data: {
          invoiceId: issue.invoiceId,
          fromStatus: "NEEDS_ATTENTION",
          toStatus: "PENDING_REVIEW",
          changedBy: session.user.id,
          reason: "Todas las incidencias descartadas/resueltas",
        },
      });
    }
  }

  revalidatePath("/dashboard/worker/issues");
  revalidatePath(`/dashboard/worker/review/${issue.invoiceId}`);
  return { success: true };
}

