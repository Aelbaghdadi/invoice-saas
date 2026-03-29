"use client";

import { useActionState } from "react";
import { forgotPasswordAction } from "./actions";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";

type FormState = { success?: boolean; error?: string } | undefined;

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    forgotPasswordAction,
    undefined
  );

  if (state?.success) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg border border-emerald-100 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
          <span>
            Si existe una cuenta con ese email, recibirás un enlace para
            restablecer tu contraseña en los próximos minutos.
          </span>
        </div>
        <Link
          href="/login"
          className="block text-center text-sm text-blue-600 hover:text-blue-700 hover:underline"
        >
          Volver al inicio de sesión
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-slate-700"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none ring-0 transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          placeholder="tu@empresa.com"
        />
      </div>

      {state?.error && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
          <span>{state.error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending ? "Enviando..." : "Enviar enlace"}
      </button>

      <p className="text-center text-sm text-slate-500">
        <Link
          href="/login"
          className="text-blue-600 hover:text-blue-700 hover:underline"
        >
          Volver al inicio de sesión
        </Link>
      </p>
    </form>
  );
}
