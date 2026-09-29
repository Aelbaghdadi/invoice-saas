"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { sendPeriodSummary } from "@/lib/periodSummary";

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

  // Solo clientes de su asesoria: sin esto, con el id de otro cliente se
  // cerraba un periodo ajeno (y ahora, ademas, se le mandaria el resumen).
  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: session.user.advisoryFirmId ?? "", isUnclassifiedBucket: false },
    select: { id: true },
  });
  if (!client) return { error: "Cliente no encontrado." };

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

  // Resumen al cliente (F-040), fuera de la petición.
  after(() => sendPeriodSummary(clientId, month, year));

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

