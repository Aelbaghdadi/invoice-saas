import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { Receipt } from "lucide-react";
import Link from "next/link";

export const metadata = {
  title: "¿Olvidaste tu contraseña? — FacturOCR",
};

export default function ForgotPasswordPage() {
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
