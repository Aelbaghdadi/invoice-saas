"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";
import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";

type FormState = { error?: string } | undefined;

export function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(
    loginAction,
    undefined
  );

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

      <div>
        <div className="flex items-center justify-between">
          <label
            htmlFor="password"
            className="block text-sm font-medium text-slate-700"
          >
            Contraseña
          </label>
          <Link
            href="/login/forgot-password"
            className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
          >
            ¿Olvidaste tu contraseña?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1.5 block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none ring-0 transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          placeholder="••••••••"
        />
      </div>

      {state?.error && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
          <span>
            {state.error === "ACCOUNT_LOCKED"
              ? "Cuenta bloqueada por demasiados intentos. Inténtalo en 15 minutos."
              : state.error === "RATE_LIMITED"
                ? "Demasiados intentos. Espera unos minutos antes de volver a probar."
                : "Email o contraseña incorrectos."}
          </span>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending ? "Iniciando sesión..." : "Iniciar sesión"}
      </button>
    </form>
  );
}
