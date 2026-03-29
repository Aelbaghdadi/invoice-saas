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

  const invoices = await prisma.invoice.findMany({
    where: { id: { in: ids }, status: { in: ["UPLOADED", "ANALYZING"] } },
  });

  if (invoices.length === 0) {
    return { error: "Ninguna factura seleccionada puede ser validada" };
  }

  await prisma.invoice.updateMany({
    where: { id: { in: invoices.map((i) => i.id) } },
    data: { status: "VALIDATED" },
  });

  await prisma.auditLog.createMany({
    data: invoices.map((inv) => ({
      invoiceId: inv.id,
      userId: session.user!.id,
      field: "status",
      oldValue: inv.status,
      newValue: "VALIDATED",
    })),
  });

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
  });

  if (invoices.length === 0) {
    return { error: "Ninguna factura seleccionada puede ser exportada (deben estar validadas)" };
  }

  await prisma.invoice.updateMany({
    where: { id: { in: invoices.map((i) => i.id) } },
    data: { status: "EXPORTED" },
  });

  await prisma.auditLog.createMany({
    data: invoices.map((inv) => ({
      invoiceId: inv.id,
      userId: session.user!.id,
      field: "status",
      oldValue: inv.status,
      newValue: "EXPORTED",
    })),
  });

  revalidatePath("/dashboard/admin/invoices");
  return { count: invoices.length };
}
