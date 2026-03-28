"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";

// ─── types ──────────────────────────────────────────────────────────────────

export type ActionState = { success?: boolean; error?: string } | null;

// ─── update firm ────────────────────────────────────────────────────────────

const firmSchema = z.object({
  name: z.string().min(2, "El nombre debe tener al menos 2 caracteres"),
  cif:  z.string().min(5, "El CIF/NIF no es válido"),
});

export async function updateFirm(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };

  const parsed = firmSchema.safeParse({
    name: fd.get("name") as string,
    cif:  fd.get("cif")  as string,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(". ") };
  }

  const firm = await prisma.advisoryFirm.findFirst({
    where: { users: { some: { id: session.user.id } } },
  });
  if (!firm) return { error: "Asesoría no encontrada" };

  try {
    await prisma.advisoryFirm.update({
      where: { id: firm.id },
      data: { name: parsed.data.name, cif: parsed.data.cif },
    });
  } catch {
    return { error: "Ese CIF ya está registrado." };
  }

  return { success: true };
}

// ─── change password ────────────────────────────────────────────────────────

const passwordSchema = z.object({
  current:  z.string().min(1, "Introduce tu contraseña actual"),
  password: z.string().min(8, "La nueva contraseña debe tener al menos 8 caracteres"),
  confirm:  z.string(),
}).refine((d) => d.password === d.confirm, {
  message: "Las contraseñas no coinciden",
  path: ["confirm"],
});

export async function changePassword(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };

  const parsed = passwordSchema.safeParse({
    current:  fd.get("current")  as string,
    password: fd.get("password") as string,
    confirm:  fd.get("confirm")  as string,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(". ") };
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) return { error: "Usuario no encontrado" };

  const valid = await bcrypt.compare(parsed.data.current, user.passwordHash);
  if (!valid) return { error: "La contraseña actual no es correcta" };

  const hash = await bcrypt.hash(parsed.data.password, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash },
  });

  return { success: true };
}

// ─── update profile ─────────────────────────────────────────────────────────

const profileSchema = z.object({
  name:  z.string().min(2, "El nombre debe tener al menos 2 caracteres"),
  email: z.string().email("Email no válido"),
});

export async function updateProfile(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") return { error: "No autorizado" };

  const parsed = profileSchema.safeParse({
    name:  fd.get("name")  as string,
    email: fd.get("email") as string,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.message).join(". ") };
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { name: parsed.data.name, email: parsed.data.email },
    });
  } catch {
    return { error: "Ese email ya está en uso." };
  }

  return { success: true };
}
