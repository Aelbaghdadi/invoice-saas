import { prisma } from "@/lib/prisma";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { Receipt, AlertTriangle } from "lucide-react";
import Link from "next/link";

export const metadata = {
  title: "Restablecer contraseña — FacturOCR",
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
    errorMessage = "No se proporcionó ningún token de restablecimiento.";
  } else {
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!resetToken) {
      errorMessage = "El enlace de restablecimiento no es válido.";
    } else if (resetToken.expiresAt < new Date()) {
      errorMessage = "El enlace ha expirado.";
    } else {
      isValid = true;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <Link href="/login" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
              <Receipt className="h-4 w-4 text-white" />
            </div>
            <span className="text-[15px] font-semibold text-slate-900">
              FacturOCR
            </span>
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
                Solicita un nuevo enlace de restablecimiento.
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
