"use server";

import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { headers } from "next/headers";
import { after } from "next/server";
import { resetPasswordRateLimit, getClientIp } from "@/lib/rateLimit";

type ForgotPasswordState = {
  success?: boolean;
  error?: string;
} | undefined;

function getAppUrl(): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

export async function forgotPasswordAction(
  _prevState: ForgotPasswordState,
  formData: FormData
): Promise<ForgotPasswordState> {
  const email = (formData.get("email") as string | null)?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Por favor, introduce un email válido." };
  }

  // Rate limit por IP + email (previene spam de emails de reset)
  const ip = getClientIp(await headers());
  const rl = resetPasswordRateLimit.check(`reset:${ip}:${email}`);
  if (!rl.allowed) {
    return { error: "Demasiadas peticiones. Inténtalo de nuevo en una hora." };
  }

  try {
    // Delete any existing tokens for this email (sin distinguir mayusculas)
    await prisma.passwordResetToken.deleteMany({ where: { email: { equals: email, mode: "insensitive" } } });

    // Only proceed if user exists (but always show success to avoid user enumeration).
    // Sin distinguir mayusculas: hay emails guardados tal cual se teclearon
    // («Ana.Garcia@Taller.es») y aqui llega en minusculas; con findUnique no
    // se encontraba al usuario y no se mandaba nada.
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
    });

    if (user?.email) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Con el email guardado: reset-password busca al usuario por el email
      // del token con findUnique.
      await prisma.passwordResetToken.create({
        data: { email: user.email, token, expiresAt },
      });

      const resetUrl = `${getAppUrl()}/login/reset-password?token=${token}`;

      // El envio va en after(): la respuesta tarda lo mismo exista o no el
      // email, aunque Resend vaya lento o este colgado (si no, el tiempo
      // delataba que la cuenta existe). Al usuario se le responde lo mismo;
      // el fallo solo queda en el log (send ya dice la plantilla y el
      // destinatario enmascarado).
      const to = user.email;
      const userId = user.id;
      after(async () => {
        const sent = await sendPasswordResetEmail({ to, resetUrl });
        if (!sent.ok) {
          console.error(`[FORGOT_PASSWORD] El enlace de restablecimiento no se ha enviado (usuario ${userId})`);
        }
      });
    }

    return { success: true };
  } catch (err) {
    console.error("[FORGOT_PASSWORD] Error:", err);
    return { error: "Ha ocurrido un error. Por favor, inténtalo de nuevo." };
  }
}
