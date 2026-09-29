"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2, Save, Check } from "lucide-react";
import { updateSimplifiedAccounts } from "./actions";
import { sanitizeAccountingAccountInput, padAccountingAccount } from "@/lib/accountingAccount";

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
  // Mismo tecleo que en la revision: solo digitos y un punto, 8 digitos como
  // mucho, y al salir se completa con ceros. Sin esto se guardaba tal cual y
  // "Usar cuenta genérica" pegaba en revision una cuenta de 9 digitos.
  const [supplier, setSupplier] = useState(initialSupplier);
  const [expense, setExpense] = useState(initialExpense);

  useEffect(() => {
    if (state?.success) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [state]);

  // Con Enter se envia sin salir del campo y el onBlur no llega a completar
  // la cuenta. Solo se completa lo editado: una cuenta antigua de otro largo
  // que no se toca se guarda como estaba.
  const submit = (formData: FormData) => {
    if (supplier !== initialSupplier) {
      const padded = padAccountingAccount(supplier);
      formData.set("simplifiedSupplierAccount", padded);
      setSupplier(padded);
    }
    if (expense !== initialExpense) {
      const padded = padAccountingAccount(expense);
      formData.set("simplifiedExpenseAccount", padded);
      setExpense(padded);
    }
    formAction(formData);
  };

  return (
    <form action={submit} className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-[13px] font-semibold text-slate-800">
        Cuenta genérica para facturas simplificadas
      </h3>
      <p className="mt-0.5 text-[12px] text-slate-500">
        Para tickets sin datos suficientes (sin NIF del emisor). El gestor la aplica con un botón
        en revisión, así todos esos tickets se agrupan en la misma cuenta.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="simplifiedSupplierAccount" className="mb-1 block text-[11px] font-medium text-slate-500">
            Cuenta proveedor (4xx)
          </label>
          <input
            id="simplifiedSupplierAccount"
            name="simplifiedSupplierAccount"
            inputMode="numeric"
            value={supplier}
            onChange={(e) => setSupplier(sanitizeAccountingAccountInput(e.target.value))}
            onBlur={(e) => { if (e.target.value !== initialSupplier) setSupplier(padAccountingAccount(e.target.value)); }}
            placeholder="40000001"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="simplifiedExpenseAccount" className="mb-1 block text-[11px] font-medium text-slate-500">
            Cuenta gasto (6xx) — opcional
          </label>
          <input
            id="simplifiedExpenseAccount"
            name="simplifiedExpenseAccount"
            inputMode="numeric"
            value={expense}
            onChange={(e) => setExpense(sanitizeAccountingAccountInput(e.target.value))}
            onBlur={(e) => { if (e.target.value !== initialExpense) setExpense(padAccountingAccount(e.target.value)); }}
            placeholder="62900000"
            className={inputClass}
          />
        </div>
      </div>
      {state?.error && <p className="mt-2 text-[12px] text-red-600">{state.error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
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
