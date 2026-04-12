"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function bulkValidateInvoices(ids: string[]) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" };
  }
  if (ids.length === 0) return { error: "No hay facturas seleccionadas" };

  // Only allow bulk validation of invoices that have been reviewed
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids }, status: { in: ["PENDING_REVIEW", "NEEDS_ATTENTION", "ANALYZED"] } },
  });

  if (invoices.length === 0) {
    return { error: "Ninguna factura seleccionada puede ser validada (deben estar revisadas)" };
  }

  const userId = session.user.id;

  // Update each invoice individually to create proper history
  for (const inv of invoices) {
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { status: "VALIDATED" },
    });

    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: inv.id,
        fromStatus: inv.status,
        toStatus: "VALIDATED",
        changedBy: userId,
        reason: "Validación masiva por admin",
      },
    });

    await prisma.auditLog.create({
      data: {
        invoiceId: inv.id,
        userId,
        field: "status",
        oldValue: inv.status,
        newValue: "VALIDATED",
      },
    });
  }

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoices.length };
}

export async function bulkExportInvoices(ids: string[]) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" };
  }
  if (ids.length === 0) return { error: "No hay facturas seleccionadas" };

  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids }, status: "VALIDATED" },
    include: { client: true },
  });

  if (invoices.length === 0) {
    return { error: "Ninguna factura seleccionada puede ser exportada (deben estar validadas)" };
  }

  const userId = session.user.id;

  // Create an ExportBatch with snapshot items (consistent with individual export flow)
  const batch = await prisma.exportBatch.create({
    data: {
      userId,
      format: "CSV",
      invoiceCount: invoices.length,
    },
  });

  for (const inv of invoices) {
    await prisma.exportBatchItem.create({
      data: {
        exportBatchId: batch.id,
        invoiceId: inv.id,
        snapshot: JSON.stringify(inv),
      },
    });

    await prisma.invoiceStatusHistory.create({
      data: {
        invoiceId: inv.id,
        fromStatus: inv.status,
        toStatus: "EXPORTED",
        changedBy: userId,
        reason: "Exportación masiva por admin",
      },
    });

    await prisma.auditLog.create({
      data: {
        invoiceId: inv.id,
        userId,
        field: "status",
        oldValue: inv.status,
        newValue: "EXPORTED",
      },
    });
  }

  // Mark invoices as EXPORTED
  await prisma.invoice.updateMany({
    where: { id: { in: invoices.map((i) => i.id) } },
    data: { status: "EXPORTED" },
  });

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoices.length };
}
