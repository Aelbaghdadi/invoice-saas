"use server";

import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

type ResetPasswordState = {
  success?: boolean;
  error?: string;
} | undefined;

export async function resetPasswordAction(
  _prevState: ResetPasswordState,
  formData: FormData
): Promise<ResetPasswordState> {
  const token = (formData.get("token") as string | null)?.trim();
  const password = formData.get("password") as string | null;
  const confirmPassword = formData.get("confirmPassword") as string | null;

  if (!token) {
    return { error: "Token inválido. Solicita un nuevo enlace de restablecimiento." };
  }

  if (!password || password.length < 6) {
    return { error: "La contraseña debe tener al menos 6 caracteres." };
  }

  if (password !== confirmPassword) {
    return { error: "Las contraseñas no coinciden." };
  }

  try {
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!resetToken) {
      return { error: "El enlace de restablecimiento no es válido. Solicita uno nuevo." };
    }

    if (resetToken.expiresAt < new Date()) {
      await prisma.passwordResetToken.delete({ where: { token } });
      return { error: "El enlace ha expirado. Solicita un nuevo enlace de restablecimiento." };
    }

    const user = await prisma.user.findUnique({
      where: { email: resetToken.email },
    });

    if (!user) {
      return { error: "No se encontró ninguna cuenta asociada a este enlace." };
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    await prisma.passwordResetToken.delete({ where: { token } });

    return { success: true };
  } catch (err) {
    console.error("[RESET_PASSWORD] Error:", err);
    return { error: "Ha ocurrido un error. Por favor, inténtalo de nuevo." };
  }
}
