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

  if (!password || password.length < 8) {
    return { error: "La contraseña debe tener al menos 8 caracteres." };
  }

  if (password !== confirmPassword) {
    return { error: "Las contraseñas no coinciden." };
  }

  try {
    // Use a transaction for atomicity — prevents race conditions with concurrent requests
    return await prisma.$transaction(async (tx) => {
      const found = await tx.passwordResetToken.findUnique({
        where: { token },
      });

      if (!found) {
        return { error: "El enlace no es válido. Solicita uno nuevo." };
      }

      if (found.expiresAt < new Date()) {
        await tx.passwordResetToken.delete({ where: { token } });
        return { error: "El enlace ha expirado. Solicita uno nuevo." };
      }

      // Delete token immediately to prevent reuse
      await tx.passwordResetToken.delete({ where: { token } });

      const user = await tx.user.findUnique({
        where: { email: found.email },
      });

      if (!user) {
        return { error: "No se encontró ninguna cuenta asociada a este enlace." };
      }

      const passwordHash = await bcrypt.hash(password, 12);

      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });

      return { success: true };
    });
  } catch (err) {
    console.error("[RESET_PASSWORD] Error:", err);
    return { error: "Ha ocurrido un error. Por favor, inténtalo de nuevo." };
  }
}
