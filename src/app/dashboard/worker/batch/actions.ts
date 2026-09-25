"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BATCH_REJECT_EXCLUDED_STATUSES, PERIOD_BLOCKING_STATUSES } from "@/lib/invoiceStatuses";
import { appendAuditLogs } from "@/lib/auditLog";
import { revalidatePath } from "next/cache";
import { canAccessClient } from "@/lib/accessibleClients";
import type { InvoiceType, InvoiceStatus, PeriodType } from "@prisma/client";

export type BatchAction =
  | { ok?: boolean; error?: string; rejectedCount?: number; warning?: string }
  | null;

/** ADMIN: solo clientes de su asesoria. WORKER: solo clientes asignados.
 *  Antes cualquier ADMIN pasaba sin mirar nada y podia cerrar o rechazar
 *  lotes de otra asesoria conociendo el clientId. */
async function assertBatchAccess(
  session: { user: { id: string; role: string; advisoryFirmId?: string | null } },
  clientId: string,
): Promise<{ error: string } | null> {
  if (await canAccessClient(session, clientId)) return null;
  return { error: "No tienes acceso a este cliente" };
}

function parseBatchParams(formData: FormData) {
  const clientId = (formData.get("clientId") as string) ?? "";
  const month = parseInt(formData.get("month") as string, 10);
  const year = parseInt(formData.get("year") as string, 10);
  const typeRaw = (formData.get("type") as string) ?? "";
  if (!clientId || !month || !year || (typeRaw !== "PURCHASE" && typeRaw !== "SALE")) {
    return null;
  }
  // Solo lo necesita rechazar lote (el cierre es del periodo entero).
  const periodTypeRaw = (formData.get("periodType") as string) ?? "";
  const periodType: PeriodType | null =
    periodTypeRaw === "MONTHLY" || periodTypeRaw === "QUARTERLY" ? periodTypeRaw : null;
  return { clientId, month, year, type: typeRaw as InvoiceType, periodType };
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
  if (!parsed) return { error: "Parámetros inválidos" };

  const access = await assertBatchAccess(session, parsed.clientId);
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
  // Un trimestre se guarda con periodMonth = su primer mes: sin filtrar por
  // la agrupacion, "rechazar T1" arrastraba tambien el lote mensual de enero.
  if (!parsed || !parsed.periodType) return { error: "Parámetros inválidos" };
  const reason = ((formData.get("reason") as string) ?? "").trim();
  if (!reason) return { error: "Indica el motivo del rechazo del lote" };

  const access = await assertBatchAccess(session, parsed.clientId);
  if (access) return access;

  const client = await prisma.client.findUnique({
    where: { id: parsed.clientId },
    select: { isUnclassifiedBucket: true },
  });
  if (!client || client.isUnclassifiedBucket) return { error: "Este lote no se puede rechazar" };

  // Mismo criterio que guardar y validar: con el periodo cerrado no se toca.
  const closure = await prisma.periodClosure.findUnique({
    where: { clientId_month_year: { clientId: parsed.clientId, month: parsed.month, year: parsed.year } },
  });
  if (closure && !closure.reopenedAt) {
    return { error: `El periodo ${parsed.month}/${parsed.year} está cerrado: pide a un administrador que lo reabra antes de rechazar el lote.` };
  }

  // Mismo criterio que isBatchRejectable (lo que cuentan las pantallas de
  // lotes). exportBatchId: exportar no cambia el estado, asi que filtrar solo
  // por el estado legacy EXPORTED no bastaba y se rechazaban lotes ya enviados.
  const where = {
    clientId: parsed.clientId,
    periodMonth: parsed.month,
    periodYear: parsed.year,
    periodType: parsed.periodType,
    type: parsed.type,
    // Nunca exportada: se mira el historial, no el puntero. Al corregir una
    // factura ya exportada el puntero se pone a null para que vuelva a la cola
    // de exportacion, y esa factura SI esta en A3.
    exportBatchItems: { none: {} },
    status: { notIn: BATCH_REJECT_EXCLUDED_STATUSES },
  };

  let rejected: { id: string; status: InvoiceStatus }[] = [];
  try {
    rejected = await prisma.$transaction(async (tx) => {
      const candidates = await tx.invoice.findMany({ where, select: { id: true, status: true } });
      if (candidates.length === 0) return [];
      const ids = candidates.map((i) => i.id);
      // El filtro se repite en el update: entre la lectura y la escritura
      // otro gestor puede haber validado o exportado alguna.
      await tx.invoice.updateMany({
        where: { ...where, id: { in: ids } },
        data: {
          status: "REJECTED",
          rejectionReason: reason,
          rejectionCategory: "OTHER",
          // Una factura pospuesta que se rechaza sale de la cola de pospuestas.
          deferredAt: null,
        },
      });
      // Historial solo de las que hemos cambiado de verdad.
      const done = await tx.invoice.findMany({
        where: { id: { in: ids }, status: "REJECTED", rejectionReason: reason },
        select: { id: true },
      });
      const doneIds = new Set(done.map((d) => d.id));
      const applied = candidates.filter((c) => doneIds.has(c.id));
      await tx.invoiceStatusHistory.createMany({
        data: applied.map((inv) => ({
          invoiceId: inv.id,
          fromStatus: inv.status,
          toStatus: "REJECTED" as InvoiceStatus,
          changedBy: session.user.id,
          reason: `Lote rechazado: ${reason}`,
        })),
      });
      return applied;
    });
  } catch (e) {
    console.error("[rejectBatch]", e);
    return { error: "No se pudo rechazar el lote. Inténtalo de nuevo." };
  }

  if (rejected.length === 0) {
    return { error: "No hay facturas en este lote que se puedan rechazar (ya exportadas, rechazadas o en análisis)" };
  }

  // La auditoria es una cadena de hash por factura en su propia transaccion
  // interactiva: en tandas para no pasarnos del timeout con lotes grandes.
  // Si aun asi falla, el rechazo ya esta hecho: se avisa, no se lanza.
  let warning: string | undefined;
  try {
    for (let i = 0; i < rejected.length; i += 25) {
      await appendAuditLogs(
        rejected.slice(i, i + 25).map((inv) => ({
          invoiceId: inv.id,
          userId: session.user.id,
          field: "status",
          oldValue: inv.status,
          newValue: "REJECTED",
        })),
      );
    }
  } catch (e) {
    console.error("[rejectBatch] auditoría", e);
    warning = "Lote rechazado, pero no se pudo registrar toda la auditoría. Avisa al administrador.";
  }

  revalidatePath("/dashboard/worker/batch", "layout");
  revalidatePath("/dashboard/admin/batch", "layout");
  revalidatePath("/dashboard/worker/invoices");
  revalidatePath("/dashboard/admin/invoices");
  return { ok: true, rejectedCount: rejected.length, warning };
}
