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
  // Sin email no se crea acceso al portal: el cliente existe solo para que la
  // asesoria le suba facturas. El nombre de contacto solo alimenta ese usuario,
  // asi que solo se exige cuando hay email.
  email: z.string().email("Email inválido").optional(),
  contactName: z.string().min(2, "Mínimo 2 caracteres").optional(),
  accountingProgram: z.string().optional(),
}).refine((d) => !d.email || d.contactName, {
  message: "Obligatorio si das acceso al portal",
  path: ["contactName"],
});

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

/**
 * Traduce un P2002 (constraint unique violada) al campo real que chocó.
 *
 * Con el adaptador @prisma/adapter-pg (Prisma 7), `meta.target` clasico
 * NO viene poblado para Postgres -- el detalle real del error viene
 * anidado en `meta.driverAdapterError.cause.constraint.fields`. Sin
 * mirar ahi, `fields` siempre quedaba vacio y todos los duplicados
 * (CIF, email del cliente, email del usuario del portal) caian en el
 * mismo mensaje generico.
 */
function duplicateFieldMessage(err: unknown): string {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const meta = err.meta as
      | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } } }
      | undefined;

    const adapterFields = meta?.driverAdapterError?.cause?.constraint?.fields;
    const target = meta?.target;
    const fields = Array.isArray(adapterFields)
      ? adapterFields.join(",")
      : Array.isArray(target)
        ? target.join(",")
        : String(target ?? "");

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
    email: ((formData.get("email") as string) || "").trim() || undefined,
    contactName: ((formData.get("contactName") as string) || "").trim() || undefined,
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

  // Contrasena temporal aleatoria (el cliente pone la suya desde la invitacion).
  // Fuera de la transaccion: bcrypt con 12 rondas tarda cientos de ms.
  const passwordHash = parsed.data.email
    ? await bcrypt.hash(randomBytes(16).toString("hex"), 12)
    : null;

  // El refine del schema ya garantiza que hay nombre de contacto siempre que
  // haya email; el respaldo existe solo para que TypeScript lo estreche.
  const contactName = parsed.data.contactName ?? parsed.data.name;

  let inviteToken: string | undefined;
  let userEmail: string | undefined;

  try {
    await prisma.$transaction(async (tx) => {
      const email = parsed.data.email;
      let portalUserId: string | null = null;

      // El usuario de portal es opcional: muchas asesorias gestionan las
      // facturas ellas mismas y no dan acceso al cliente.
      if (email && passwordHash) {
        const user = await tx.user.create({
          data: {
            // El cliente inicia sesión con su username; por defecto = su email.
            username: email,
            email,
            passwordHash,
            name: contactName,
            role: "CLIENT",
            advisoryFirmId: firm.id,
          },
        });
        portalUserId = user.id;

        // Create password reset token for invitation (72h expiry)
        const token = randomUUID();
        await tx.passwordResetToken.create({
          data: {
            email,
            token,
            expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          },
        });

        inviteToken = token;
        userEmail = email;
      }

      await tx.client.create({
        data: {
          name: parsed.data.name,
          cif: parsed.data.cif.toUpperCase(),
          email: email ?? null,
          accountingProgram: parsed.data.accountingProgram || null,
          advisoryFirmId: firm.id,
          userId: portalUserId,
        },
      });
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
        clientName: contactName,
        inviteUrl,
      });
    });
  }

  redirect("/dashboard/admin/clients");
}
