"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export async function closePeriod(formData: FormData) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado." };
  }

  const clientId = formData.get("clientId") as string;
  const month = parseInt(formData.get("month") as string, 10);
  const year = parseInt(formData.get("year") as string, 10);

  if (!clientId || !month || !year) {
    return { error: "Faltan datos obligatorios." };
  }

  // Check if already closed
  const existing = await prisma.periodClosure.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });

  if (existing && !existing.reopenedAt) {
    return { error: "Este periodo ya está cerrado." };
  }

  // Upsert: if was reopened, re-close it
  await prisma.periodClosure.upsert({
    where: { clientId_month_year: { clientId, month, year } },
    create: {
      clientId,
      month,
      year,
      closedBy: session.user.id,
    },
    update: {
      closedBy: session.user.id,
      closedAt: new Date(),
      reopenedAt: null,
      reopenedBy: null,
    },
  });

  revalidatePath("/dashboard/admin/closures");
  return { success: true };
}

export async function reopenPeriod(formData: FormData) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado." };
  }

  const closureId = formData.get("closureId") as string;
  if (!closureId) return { error: "Falta el ID del cierre." };

  await prisma.periodClosure.update({
    where: { id: closureId },
    data: {
      reopenedAt: new Date(),
      reopenedBy: session.user.id,
    },
  });

  revalidatePath("/dashboard/admin/closures");
  return { success: true };
}

/**
 * Check if a period is closed for a given client.
 */
export async function isPeriodClosed(
  clientId: string,
  month: number,
  year: number
): Promise<boolean> {
  const closure = await prisma.periodClosure.findUnique({
    where: { clientId_month_year: { clientId, month, year } },
  });
  return !!closure && !closure.reopenedAt;
}
