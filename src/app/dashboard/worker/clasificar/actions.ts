"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessClient } from "@/lib/accessibleClients";
import { appendAuditLogs } from "@/lib/auditLog";
import { revalidatePath } from "next/cache";

export type ClassifyState = { ok?: boolean; error?: string } | null;

/**
 * Clasifica manualmente una factura "Por clasificar": la asigna al cliente
 * elegido (que debe ser uno de sus candidatos), fuerza la parte conocida del
 * cliente según el tipo y la saca del buzón hacia la cola de revisión normal.
 */
export async function classifyInvoice(invoiceId: string, clientId: string): Promise<ClassifyState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "PENDING_ROUTING") {
    return { error: "La factura no está pendiente de clasificar" };
  }
  // El cliente elegido debe ser uno de los candidatos del lote y accesible.
  if (!invoice.routingCandidateIds.includes(clientId)) {
    return { error: "Cliente no válido para esta factura" };
  }
  if (!(await canAccessClient(session, clientId))) {
    return { error: "No tienes acceso a ese cliente" };
  }

  // No clasificar a un periodo ya cerrado del cliente destino.
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: { clientId, month: invoice.periodMonth, year: invoice.periodYear },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: `El periodo ${invoice.periodMonth}/${invoice.periodYear} de ese cliente está cerrado` };
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, cif: true },
  });
  if (!client) return { error: "Cliente no encontrado" };

  // Forzar la parte conocida del cliente según el tipo (igual que el pipeline).
  const isPurchase = invoice.type === "PURCHASE";
  const clientSide = isPurchase
    ? { receiverName: client.name, receiverCif: client.cif }
    : { issuerName: client.name, issuerCif: client.cif, issuerCountry: null };

  // Dedupe básico contra el cliente real (estrategia CIF + nº factura).
  const otherCif = isPurchase ? invoice.issuerCif : invoice.receiverCif;
  let isDuplicate = false;
  if (otherCif && invoice.invoiceNumber) {
    const dup = await prisma.invoice.findFirst({
      where: {
        clientId,
        type: invoice.type,
        id: { not: invoiceId },
        status: { notIn: ["REJECTED", "PENDING_ROUTING"] },
        issuerCif: isPurchase ? otherCif : undefined,
        receiverCif: isPurchase ? undefined : otherCif,
        invoiceNumber: invoice.invoiceNumber,
      },
      select: { id: true, filename: true },
    });
    if (dup) {
      isDuplicate = true;
      await prisma.invoiceIssue.create({
        data: {
          invoiceId,
          type: "POSSIBLE_DUPLICATE",
          description: `Posible duplicado de "${dup.filename}" (misma factura ${invoice.invoiceNumber}).`,
        },
      });
    }
  }

  const targetStatus = isDuplicate || invoice.isValid === false ? "NEEDS_ATTENTION" : "PENDING_REVIEW";

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      clientId,
      ...clientSide,
      status: targetStatus,
      routingCandidateIds: [],
      routingReason: null,
    },
  });

  await prisma.invoiceStatusHistory.create({
    data: {
      invoiceId,
      fromStatus: "PENDING_ROUTING",
      toStatus: targetStatus,
      changedBy: session.user.id,
      reason: `Clasificada manualmente a ${client.name}`,
    },
  });

  await appendAuditLogs([{
    invoiceId,
    userId: session.user.id,
    field: "status",
    oldValue: "PENDING_ROUTING",
    newValue: targetStatus,
  }]);

  revalidatePath("/dashboard/worker/clasificar");
  revalidatePath("/dashboard/worker/invoices");
  return { ok: true };
}

/** Descarta una factura del buzón (no pertenece a ningún cliente del lote). */
export async function discardUnclassified(invoiceId: string): Promise<ClassifyState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado" };
  }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "PENDING_ROUTING") {
    return { error: "La factura no está pendiente de clasificar" };
  }
  // Acceso: el gestor debe tener acceso a alguno de los candidatos del lote.
  const accesses = await Promise.all(invoice.routingCandidateIds.map((c) => canAccessClient(session, c)));
  if (!accesses.some(Boolean)) return { error: "No tienes acceso a esta factura" };

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "REJECTED",
      rejectionCategory: "OTHER",
      rejectionReason: "Descartada al clasificar: no pertenece a ningún cliente del lote.",
      routingReason: null,
    },
  });
  await prisma.invoiceStatusHistory.create({
    data: { invoiceId, fromStatus: "PENDING_ROUTING", toStatus: "REJECTED", changedBy: session.user.id, reason: "Descartada al clasificar" },
  });
  await appendAuditLogs([{ invoiceId, userId: session.user.id, field: "status", oldValue: "PENDING_ROUTING", newValue: "REJECTED" }]);

  revalidatePath("/dashboard/worker/clasificar");
  return { ok: true };
}
