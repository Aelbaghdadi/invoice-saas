"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import type { InvoiceType } from "@prisma/client";

export type BatchAction =
  | { ok?: boolean; error?: string }
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
      status: {
        in: ["UPLOADED", "ANALYZING", "ANALYZED", "PENDING_REVIEW", "NEEDS_ATTENTION", "OCR_ERROR"],
      },
    },
  });
  if (pending > 0) {
    return {
      error: `Aun quedan ${pending} factura${pending !== 1 ? "s" : ""} sin procesar en el periodo`,
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
    return { error: "Este periodo ya esta cerrado" };
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
