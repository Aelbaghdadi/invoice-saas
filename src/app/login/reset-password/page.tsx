import { prisma } from "@/lib/prisma";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { AlertTriangle } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

// Aqui llega tambien el cliente nuevo desde el correo de invitacion, que no
// restablece nada: los textos hablan de "nueva contraseña".
export const metadata = {
  title: `Nueva contraseña — ${BRAND}`,
};

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token } = await searchParams;

  // Validate token
  let isValid = false;
  let errorMessage = "";

  if (!token) {
    errorMessage = "El enlace está incompleto.";
  } else {
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!resetToken) {
      errorMessage = "El enlace no es válido.";
    } else if (resetToken.expiresAt < new Date()) {
      errorMessage = "El enlace ha expirado.";
    } else {
      isValid = true;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center">
          {/* El mismo logo que el login. */}
          <Link href="/login">
            <Image
              src="/brand/faktury-logo.svg"
              alt={BRAND}
              width={192}
              height={64}
              priority
              className="h-16 w-auto"
            />
          </Link>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {isValid && token ? (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                Nueva contraseña
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                Introduce y confirma tu nueva contraseña para acceder a tu
                cuenta.
              </p>
              <div className="mt-6">
                <ResetPasswordForm token={token} />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-amber-100">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                </div>
                <h1 className="text-xl font-semibold text-slate-900">
                  Enlace no válido
                </h1>
              </div>
              <p className="mt-4 text-sm text-slate-500">{errorMessage}</p>
              <p className="mt-1 text-sm text-slate-500">
                Solicita un nuevo enlace para establecer tu contraseña.
              </p>
              <div className="mt-6 space-y-3">
                <Link
                  href="/login/forgot-password"
                  className="flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
                >
                  Solicitar nuevo enlace
                </Link>
                <Link
                  href="/login"
                  className="block text-center text-sm text-slate-500 hover:text-slate-700 hover:underline"
                >
                  Volver al inicio de sesión
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
