"use client";

import { useActionState } from "react";
import { createWorker } from "./actions";
import { Loader2, AlertCircle } from "lucide-react";

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

export function WorkerForm() {
  const [state, action, pending] = useActionState<State, FormData>(createWorker, undefined);

  return (
    <form action={action} className="space-y-4">
      {state?.error && (
        <div className="flex items-center gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
          {state.error}
        </div>
      )}

      <div>
        <label className="block text-[13px] font-medium text-slate-700">Nombre completo *</label>
        <input name="name" required className="input mt-1.5 w-full" placeholder="Ana García López" />
        {state?.errors?.name && <p className="mt-1 text-[12px] text-red-500">{state.errors.name[0]}</p>}
      </div>

      <div>
        <label className="block text-[13px] font-medium text-slate-700">Email *</label>
        <input name="email" type="email" required className="input mt-1.5 w-full" placeholder="ana@asesoría.com" />
        {state?.errors?.email && <p className="mt-1 text-[12px] text-red-500">{state.errors.email[0]}</p>}
      </div>

      <div>
        <label className="block text-[13px] font-medium text-slate-700">Contraseña *</label>
        <input name="password" type="password" required minLength={8} className="input mt-1.5 w-full" placeholder="Mín. 8 caracteres" />
        {state?.errors?.password && <p className="mt-1 text-[12px] text-red-500">{state.errors.password[0]}</p>}
      </div>

      <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? "Creando..." : "Crear gestor"}
        </button>
        <a href="/dashboard/admin/workers" className="text-[13px] text-slate-500 hover:text-slate-700">Cancelar</a>
      </div>
    </form>
  );
}
