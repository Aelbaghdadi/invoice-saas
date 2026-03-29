"use client";

import { useActionState, useEffect, useState } from "react";
import { createClient } from "./actions";
import { Loader2, AlertCircle, Info } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";

type State = { error?: string; errors?: Record<string, string[]> } | undefined;

const PROGRAMS = ["Sage 50", "Contasol", "a3con", "ContaPlus", "Holded", "Otro"];

export function ClientForm() {
  const { success, error: toastError } = useToast();
  const [state, action, pending] = useActionState<State, FormData>(createClient, undefined);
  const [program, setProgram] = useState("");

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toastError("Error al crear cliente");
    } else if (!state.errors) {
      success("Cliente creado correctamente");
    }
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form action={action} className="space-y-4">
      {state?.error && (
        <div className="flex items-center gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
          {state.error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="block text-[13px] font-medium text-slate-700">
            Razón social *
          </label>
          <input
            name="name"
            required
            className="input mt-1.5 w-full"
            placeholder="Empresa S.L."
          />
          {state?.errors?.name && (
            <p className="mt-1 text-[12px] text-red-500">{state.errors.name[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-[13px] font-medium text-slate-700">CIF *</label>
          <input
            name="cif"
            required
            className="input mt-1.5 w-full"
            placeholder="B12345678"
            maxLength={9}
          />
          {state?.errors?.cif && (
            <p className="mt-1 text-[12px] text-red-500">{state.errors.cif[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-[13px] font-medium text-slate-700">
            Email de acceso *
          </label>
          <input
            name="email"
            type="email"
            required
            className="input mt-1.5 w-full"
            placeholder="contacto@empresa.com"
          />
          {state?.errors?.email && (
            <p className="mt-1 text-[12px] text-red-500">{state.errors.email[0]}</p>
          )}
        </div>

        <div className="col-span-2">
          <label className="block text-[13px] font-medium text-slate-700">
            Nombre del contacto *
          </label>
          <input
            name="contactName"
            required
            className="input mt-1.5 w-full"
            placeholder="María García"
          />
          {state?.errors?.contactName && (
            <p className="mt-1 text-[12px] text-red-500">{state.errors.contactName[0]}</p>
          )}
        </div>

        <div className="col-span-2">
          <label className="block text-[13px] font-medium text-slate-700">
            Software contable
          </label>
          <Select
            name="accountingProgram"
            value={program}
            onChange={setProgram}
            placeholder="— Seleccionar —"
            className="mt-1.5"
            options={PROGRAMS.map((p) => ({ value: p, label: p }))}
          />
        </div>
      </div>

      {/* Password info */}
      <div className="flex items-start gap-2.5 rounded-lg border border-blue-100 bg-blue-50 px-3.5 py-3">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-500" />
        <p className="text-[12px] text-blue-700">
          Se creará automáticamente una cuenta de portal para el cliente. La contraseña inicial será los últimos 6 dígitos del CIF seguidos de{" "}
          <code className="font-mono font-semibold">!</code>
        </p>
      </div>

      <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {pending ? "Creando..." : "Crear cliente"}
        </button>
        <a
          href="/dashboard/admin/clients"
          className="text-[13px] text-slate-500 hover:text-slate-700"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
