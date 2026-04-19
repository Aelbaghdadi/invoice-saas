"use server";

import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { headers } from "next/headers";
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
    // Delete any existing tokens for this email
    await prisma.passwordResetToken.deleteMany({ where: { email } });

    // Only proceed if user exists (but always show success to avoid user enumeration)
    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.passwordResetToken.create({
        data: { email, token, expiresAt },
      });

      const resetUrl = `${getAppUrl()}/login/reset-password?token=${token}`;

      await sendPasswordResetEmail({ to: email, resetUrl });
    }

    return { success: true };
  } catch (err) {
    console.error("[FORGOT_PASSWORD] Error:", err);
    return { error: "Ha ocurrido un error. Por favor, inténtalo de nuevo." };
  }
}
