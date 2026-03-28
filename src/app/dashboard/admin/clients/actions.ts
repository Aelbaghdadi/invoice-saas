"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import bcrypt from "bcryptjs";

const schema = z.object({
  name: z.string().min(2, "Mínimo 2 caracteres"),
  cif: z.string().min(9, "El CIF debe tener 9 caracteres").max(9, "El CIF debe tener 9 caracteres"),
  email: z.string().email("Email inválido"),
  contactName: z.string().min(2, "Mínimo 2 caracteres"),
  accountingProgram: z.string().optional(),
});

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

export async function createClient(_prev: State, formData: FormData): Promise<State> {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return { error: "No autorizado" };
  }

  const raw = {
    name: formData.get("name") as string,
    cif: formData.get("cif") as string,
    email: formData.get("email") as string,
    contactName: formData.get("contactName") as string,
    accountingProgram: (formData.get("accountingProgram") as string) || undefined,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }

  const firm = await prisma.advisoryFirm.findFirst({
    where: { users: { some: { id: session.user.id } } },
  });
  if (!firm) return { error: "Asesoría no encontrada" };

  // Default portal password = last 6 chars of CIF + "!"
  const defaultPassword = parsed.data.cif.slice(-6) + "!";
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  try {
    await prisma.$transaction(async (tx) => {
      // Create portal user
      const user = await tx.user.create({
        data: {
          email: parsed.data.email,
          passwordHash,
          name: parsed.data.contactName,
          role: "CLIENT",
          advisoryFirmId: firm.id,
        },
      });

      // Create client linked to user
      await tx.client.create({
        data: {
          name: parsed.data.name,
          cif: parsed.data.cif.toUpperCase(),
          email: parsed.data.email,
          accountingProgram: parsed.data.accountingProgram || null,
          advisoryFirmId: firm.id,
          userId: user.id,
        },
      });
    });
  } catch {
    return { error: "Ya existe un cliente con ese CIF o email." };
  }

  redirect("/dashboard/admin/clients");
}
