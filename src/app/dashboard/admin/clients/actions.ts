"use server";

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { sendClientInvitationEmail } from "@/lib/email";
import { isValidNIF, formatNIF } from "@/lib/validators";

const schema = z.object({
  name: z.string().min(2, "Mínimo 2 caracteres"),
  cif: z.string().min(9, "El CIF debe tener 9 caracteres").max(9, "El CIF debe tener 9 caracteres")
    .transform(formatNIF)
    .refine(isValidNIF, "CIF/NIF inválido — comprueba el formato y la letra de control"),
  email: z.string().email("Email inválido"),
  contactName: z.string().min(2, "Mínimo 2 caracteres"),
  accountingProgram: z.string().optional(),
});

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

/**
 * Traduce un P2002 (constraint unique violada) al campo real que chocó,
 * mirando `meta.target`. Sin esto, cualquier duplicado (CIF, email del
 * cliente o email del usuario del portal) mostraba el mismo mensaje
 * generico y confundia sobre cual era el campo repetido de verdad.
 */
function duplicateFieldMessage(err: unknown): string {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = err.meta?.target;
    const fields = Array.isArray(target) ? target.join(",") : String(target ?? "");
    if (fields.includes("cif")) return "Ya existe un cliente con ese CIF.";
    if (fields.includes("email")) return "Ya existe un cliente o usuario con ese email.";
  }
  return "Ya existe un cliente con ese CIF o email.";
}

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

  // Generate a secure random temporary password (user will set their own via invitation)
  const tempPassword = randomBytes(16).toString("hex");
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  let inviteToken: string | undefined;
  let userEmail: string | undefined;

  try {
    await prisma.$transaction(async (tx) => {
      // Create portal user
      const user = await tx.user.create({
        data: {
          // El cliente inicia sesión con su username; por defecto = su email.
          username: parsed.data.email,
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

      // Create password reset token for invitation (72h expiry)
      const token = randomUUID();
      await tx.passwordResetToken.create({
        data: {
          email: parsed.data.email,
          token,
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });

      inviteToken = token;
      userEmail = parsed.data.email;
    });
  } catch (err) {
    return { error: duplicateFieldMessage(err) };
  }

  // Send invitation email after the response is sent
  if (inviteToken && userEmail) {
    const appUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const inviteUrl = `${appUrl}/login/reset-password?token=${inviteToken}`;

    after(() => {
      sendClientInvitationEmail({
        to: userEmail!,
        clientName: parsed.data.contactName,
        inviteUrl,
      });
    });
  }

  redirect("/dashboard/admin/clients");
}
