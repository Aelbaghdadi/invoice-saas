import { ForgotPasswordForm } from "./ForgotPasswordForm";
import Image from "next/image";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

export const metadata = {
  title: "¿Olvidaste tu contraseña? — Faktury",
};

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo: el mismo que el login. */}
        <div className="mb-8 flex items-center justify-center">
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
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Recuperar contraseña
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Introduce tu email y te enviaremos un enlace para restablecer tu
            contraseña.
          </p>

          <div className="mt-6">
            <ForgotPasswordForm />
          </div>
        </div>
      </div>
    </div>
  );
}
