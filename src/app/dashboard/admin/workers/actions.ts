"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import bcrypt from "bcryptjs";

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

export async function createWorker(_prev: State, formData: FormData): Promise<State> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "Unauthorized" };

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
  if (!firm) return { error: "Advisory firm not found" };

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  try {
    await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash,
        role: "WORKER",
        advisoryFirmId: firm.id,
      },
    });
  } catch {
    return { error: "A user with this email already exists." };
  }

  redirect("/dashboard/admin/workers");
}

async function requireAdminFirm() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "Unauthorized" as const };
  }
  const firmId = session.user.advisoryFirmId;
  if (!firmId) return { error: "Forbidden" as const };
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

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Not found" };

  const client = await prisma.client.findFirst({
    where: { id: clientId, advisoryFirmId: ctx.firmId },
    select: { id: true },
  });
  if (!client) return { error: "Not found" };

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

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Not found" };

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

  if (!(await workerBelongsToFirm(workerId, ctx.firmId))) return { error: "Not found" };

  const count = await prisma.workerClientAssignment.count({ where: { workerId } });
  if (count > 0) {
    return { error: "El gestor tiene clientes asignados. Desasígnalos antes de eliminar." };
  }

  await prisma.user.delete({ where: { id: workerId } });

  revalidatePath("/dashboard/admin/workers");
  redirect("/dashboard/admin/workers");
}
