"use server";

import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";

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
