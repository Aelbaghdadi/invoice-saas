"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2, Save, Check } from "lucide-react";
import { updateSimplifiedAccounts } from "./actions";

type Props = {
  clientId: string;
  initialSupplier: string;
  initialExpense: string;
};

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-800 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-100";

/**
 * Configura, por cliente, la cuenta de proveedor (y opcional de gasto) que se
 * usará para tickets / facturas simplificadas sin datos suficientes. Solo
 * define el valor; el gestor lo aplica con un botón en la pantalla de revisión.
 */
export function SimplifiedAccountsConfig({ clientId, initialSupplier, initialExpense }: Props) {
  const action = updateSimplifiedAccounts.bind(null, clientId);
  const [state, formAction, pending] = useActionState(action, null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (state?.success) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <form action={formAction} className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-[13px] font-semibold text-slate-800">
        Cuenta genérica para facturas simplificadas
      </h3>
      <p className="mt-0.5 text-[12px] text-slate-500">
        Para tickets sin datos suficientes (sin NIF del emisor). El gestor la aplica con un botón
        en revisión, así todos esos tickets se agrupan en la misma cuenta.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-500">
            Cuenta proveedor (4xx)
          </label>
          <input
            name="simplifiedSupplierAccount"
            defaultValue={initialSupplier}
            placeholder="4999999"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-slate-500">
            Cuenta gasto (6xx) — opcional
          </label>
          <input
            name="simplifiedExpenseAccount"
            defaultValue={initialExpense}
            placeholder="629000000"
            className={inputClass}
          />
        </div>
      </div>
      {state?.error && <p className="mt-2 text-[12px] text-red-600">{state.error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Guardar
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-[12px] font-medium text-green-600">
            <Check className="h-3.5 w-3.5" />
            Guardado
          </span>
        )}
      </div>
    </form>
  );
}
