"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PERIOD_BLOCKING_STATUSES } from "@/lib/invoiceStatuses";
import { appendAuditLogs } from "@/lib/auditLog";
import { revalidatePath } from "next/cache";
import type { InvoiceType, InvoiceStatus } from "@prisma/client";

export type BatchAction =
  | { ok?: boolean; error?: string; rejectedCount?: number }
  | null;

async function assertBatchAccess(
  userId: string,
  role: string,
  clientId: string,
): Promise<{ error: string } | null> {
  if (role === "ADMIN") return null;
  if (role !== "WORKER") return { error: "No autorizado" };
  const assignment = await prisma.workerClientAssignment.findUnique({
    where: { workerId_clientId: { workerId: userId, clientId } },
  });
  if (!assignment) return { error: "No tienes acceso a este cliente" };
  return null;
}

function parseBatchParams(formData: FormData) {
  const clientId = (formData.get("clientId") as string) ?? "";
  const month = parseInt(formData.get("month") as string, 10);
  const year = parseInt(formData.get("year") as string, 10);
  const typeRaw = (formData.get("type") as string) ?? "";
  if (!clientId || !month || !year || (typeRaw !== "PURCHASE" && typeRaw !== "SALE")) {
    return null;
  }
  return { clientId, month, year, type: typeRaw as InvoiceType };
}

/**
 * Cierra el periodo (cliente + mes + año) desde la tarjeta del lote.
 *
 * Prerrequisito: TODAS las facturas del batch (independientemente del tipo,
 * porque un cierre fiscal cubre todo el periodo del cliente) deben estar
 * en estado final (VALIDATED/REJECTED/EXPORTED). Si queda algo pendiente,
 * el cierre se rechaza con el numero exacto que falta.
 *
 * Tanto WORKER (asignado al cliente) como ADMIN pueden cerrar.
 */
export async function closePeriodFromBatch(
  _prev: BatchAction,
  formData: FormData,
): Promise<BatchAction> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const parsed = parseBatchParams(formData);
  if (!parsed) return { error: "Parametros invalidos" };

  const access = await assertBatchAccess(session.user.id, session.user.role, parsed.clientId);
  if (access) return access;

  // Comprobar que no queda nada pendiente en el periodo (todo tipo). El
  // cierre es del periodo completo, no solo del tipo.
  const pending = await prisma.invoice.count({
    where: {
      clientId: parsed.clientId,
      periodMonth: parsed.month,
      periodYear: parsed.year,
      status: { in: PERIOD_BLOCKING_STATUSES },
    },
  });
  if (pending > 0) {
    return {
      error: `Aún quedan ${pending} factura${pending !== 1 ? "s" : ""} sin procesar en el periodo`,
    };
  }

  const existing = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: {
        clientId: parsed.clientId,
        month: parsed.month,
        year: parsed.year,
      },
    },
  });
  if (existing && !existing.reopenedAt) {
    return { error: "Este periodo ya está cerrado" };
  }

  await prisma.periodClosure.upsert({
    where: {
      clientId_month_year: {
        clientId: parsed.clientId,
        month: parsed.month,
        year: parsed.year,
      },
    },
    create: {
      clientId: parsed.clientId,
      month: parsed.month,
      year: parsed.year,
      closedBy: session.user.id,
    },
    update: {
      closedBy: session.user.id,
      closedAt: new Date(),
      reopenedAt: null,
      reopenedBy: null,
    },
  });

  revalidatePath("/dashboard/worker/batch");
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/admin/closures");
  return { ok: true };
}

/**
 * Rechaza un lote completo (cliente + periodo + tipo) — pensado para cuando
 * se ha subido por error. NO es un DELETE físico: reutiliza el mismo estado
 * REJECTED y el mismo historial/auditoría que el rechazo de una factura
 * individual, así el lote queda fuera del flujo normal de revisión/export
 * (REJECTED no aparece en PENDING_WORK ni bloquea el cierre de periodo) sin
 * perder ningún dato ni dejar registros huérfanos.
 *
 * Se excluyen del rechazo las facturas que ya estén REJECTED (idempotente),
 * EXPORTED (ya salieron hacia la contabilidad del cliente — deshacer eso no
 * es "rechazar un lote", es un caso distinto) o SPLIT_SOURCE (la foto
 * original de una división: sus hijas son las facturas reales y sí entran).
 */
export async function rejectBatch(
  _prev: BatchAction,
  formData: FormData,
): Promise<BatchAction> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const parsed = parseBatchParams(formData);
  if (!parsed) return { error: "Parametros invalidos" };
  const reason = ((formData.get("reason") as string) ?? "").trim();
  if (!reason) return { error: "Indica el motivo del rechazo del lote" };

  const access = await assertBatchAccess(session.user.id, session.user.role, parsed.clientId);
  if (access) return access;

  const invoices = await prisma.invoice.findMany({
    where: {
      clientId: parsed.clientId,
      periodMonth: parsed.month,
      periodYear: parsed.year,
      type: parsed.type,
      status: { notIn: ["REJECTED", "EXPORTED", "SPLIT_SOURCE"] as InvoiceStatus[] },
    },
    select: { id: true, status: true },
  });

  if (invoices.length === 0) {
    return { error: "No hay facturas en este lote que se puedan rechazar (ya exportadas o rechazadas)" };
  }

  const invoiceIds = invoices.map((i) => i.id);

  await prisma.$transaction([
    prisma.invoice.updateMany({
      where: { id: { in: invoiceIds } },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        rejectionCategory: "OTHER",
        // Una factura pospuesta que se rechaza sale de la cola de pospuestas.
        deferredAt: null,
      },
    }),
    prisma.invoiceStatusHistory.createMany({
      data: invoices.map((inv) => ({
        invoiceId: inv.id,
        fromStatus: inv.status,
        toStatus: "REJECTED" as InvoiceStatus,
        changedBy: session.user.id,
        reason: `Lote rechazado: ${reason}`,
      })),
    }),
  ]);

  await appendAuditLogs(
    invoices.map((inv) => ({
      invoiceId: inv.id,
      userId: session.user.id,
      field: "status",
      oldValue: inv.status,
      newValue: "REJECTED",
    })),
  );

  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  revalidatePath("/dashboard/worker/invoices");
  return { ok: true, rejectedCount: invoices.length };
}
