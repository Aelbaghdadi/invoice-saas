"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import bcrypt from "bcryptjs";

const schema = z.object({
  name: z.string().min(2, "Mínimo 2 caracteres"),
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "Mínimo 8 caracteres"),
});

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

export async function createWorker(_prev: State, formData: FormData): Promise<State> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };

  const raw = {
    name: formData.get("name") as string,
    email: formData.get("email") as string,
    password: formData.get("password") as string,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const firm = await prisma.advisoryFirm.findFirst({
    where: { users: { some: { id: session.user.id } } },
  });
  if (!firm) return { error: "Asesoría no encontrada" };

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  try {
    await prisma.user.create({
      data: {
        name: parsed.data.name,
        // El gestor inicia sesión con su username; por defecto = su email
        // (único), hasta que exista un campo de usuario propio en el alta.
        username: parsed.data.email,
        email: parsed.data.email,
        passwordHash,
        role: "WORKER",
        advisoryFirmId: firm.id,
      },
    });
  } catch {
    return { error: "Ya existe un usuario con ese email." };
  }

  redirect("/dashboard/admin/workers");
}

async function requireAdminFirm() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" as const };
  }
  const firmId = session.user.advisoryFirmId;
  if (!firmId) return { error: "Tu usuario no está asociado a una asesoría" as const };
  return { firmId };
}

async function workerBelongsToFirm(workerId: string, firmId: string) {
  const worker = await prisma.user.findFirst({
    where: { id: workerId, role: "WORKER", advisoryFirmId: firmId },
    select: { id: true },
  });
  return !!worker;
}

export async function assignClientToWorker(workerId: string, clientId: string) {
  const ctx = await requireAdminFirm();
  if ("error" in ctx) return ctx;

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Gestor no encontrado" };

  // El cliente técnico "Sin clasificar" no se asigna: no es un cliente real.
  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: ctx.firmId, isUnclassifiedBucket: false },
    select: { id: true },
  });
  if (!client) return { error: "Cliente no encontrado" };

  await prisma.workerClientAssignment.upsert({
    where: { workerId_clientId: { workerId, clientId } },
    update: {},
    create: { workerId, clientId },
  });

  revalidatePath(`/dashboard/admin/workers/${workerId}`);
  revalidatePath("/dashboard/admin/workers");
  return { ok: true };
}

export async function unassignClientFromWorker(workerId: string, clientId: string) {
  const ctx = await requireAdminFirm();
  if ("error" in ctx) return ctx;

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Gestor no encontrado" };

  await prisma.workerClientAssignment.deleteMany({
    where: { workerId, clientId, client: { advisoryFirmId: ctx.firmId } },
  });

  revalidatePath(`/dashboard/admin/workers/${workerId}`);
  revalidatePath("/dashboard/admin/workers");
  return { ok: true };
}

export async function deleteWorker(workerId: string) {
  const ctx = await requireAdminFirm();
  if ("error" in ctx) return ctx;

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Gestor no encontrado" };

  const count = await prisma.workerClientAssignment.count({ where: { workerId } });
  if (count > 0) {
    return { error: "El gestor tiene clientes asignados. Desasígnalos antes de eliminar." };
  }

  try {
    await prisma.user.delete({ where: { id: workerId } });
  } catch {
    // La auditoria es inmutable y apunta al usuario: quien ya ha tocado
    // facturas no se puede borrar. Sin esto la accion reventaba en la UI.
    return { error: "No se puede eliminar: el gestor tiene cambios registrados en la auditoría, que debe conservarse." };
  }

  revalidatePath("/dashboard/admin/workers");
  redirect("/dashboard/admin/workers");
}
