"use client";

import { useActionState, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, Loader2, Save } from "lucide-react";
import { updateClient, type EditClientState } from "./actions";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import { MONTH_NAMES } from "@/lib/period";

const PROGRAMS = ["A3 Asesor", "Otro"];

// Enero es el año natural: el ejercicio de casi todos los clientes.
const FISCAL_MONTHS = MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: i === 0 ? `${name} (año natural)` : name }));

type Props = {
  clientId: string;
  initial: {
    name: string;
    cif: string;
    accountingProgram: string | null;
    contactName: string | null;
    phone: string | null;
    notes: string | null;
    fiscalYearStartMonth: number;
  };
  /** Ya tiene facturas: cambiar el ejercicio reagrupa su archivo. */
  hasInvoices: boolean;
};

function FieldError({ errors, name }: { errors?: Record<string, string[]>; name: string }) {
  const msg = errors?.[name]?.[0];
  return msg ? <p className="mt-1 text-[12px] text-red-500">{msg}</p> : null;
}

/** Razon social, CIF, software, contacto, telefono, notas internas y el mes
 *  en que empieza el ejercicio. */
export function EditClientForm({ clientId, initial, hasInvoices }: Props) {
  const action = updateClient.bind(null, clientId);
  const [state, formAction, pending] = useActionState<EditClientState, FormData>(action, null);
  const { success, error: toastError } = useToast();
  // Si el software no es uno de la lista (dato antiguo), se conserva como opcion.
  const programs = initial.accountingProgram && !PROGRAMS.includes(initial.accountingProgram)
    ? [initial.accountingProgram, ...PROGRAMS]
    : PROGRAMS;
  const [program, setProgram] = useState(initial.accountingProgram ?? "");
  const [fiscalMonth, setFiscalMonth] = useState(String(initial.fiscalYearStartMonth));
  const regroups = hasInvoices && fiscalMonth !== String(initial.fiscalYearStartMonth);

  useEffect(() => {
    if (!state) return;
    if (state.success) success("Ficha guardada");
    else if (state.error) toastError(state.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border border-red-100 bg-red-50 px-3.5 py-3 text-[13px] text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500" />
          {state.error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="client-name" className="block text-[13px] font-medium text-slate-700">Razón social *</label>
          <input id="client-name" name="name" required defaultValue={initial.name} className="input mt-1.5 w-full" />
          <FieldError errors={state?.errors} name="name" />
        </div>

        <div>
          <label htmlFor="client-cif" className="block text-[13px] font-medium text-slate-700">CIF *</label>
          <input id="client-cif" name="cif" required maxLength={9} defaultValue={initial.cif} className="input mt-1.5 w-full font-mono uppercase" />
          <FieldError errors={state?.errors} name="cif" />
          <p className="mt-1 text-[11px] text-slate-400">Cambiarlo afecta al ruteo automático de las facturas nuevas.</p>
        </div>

        <div>
          <label htmlFor="client-program" className="block text-[13px] font-medium text-slate-700">Software contable</label>
          <Select
            id="client-program"
            name="accountingProgram"
            value={program}
            onChange={setProgram}
            placeholder="— Seleccionar —"
            className="mt-1.5"
            options={[{ value: "", label: "— Sin programa —" }, ...programs.map((p) => ({ value: p, label: p }))]}
            searchable={false}
          />
          <FieldError errors={state?.errors} name="accountingProgram" />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="client-fiscal-month" className="block text-[13px] font-medium text-slate-700">El ejercicio empieza en</label>
          <Select
            id="client-fiscal-month"
            name="fiscalYearStartMonth"
            value={fiscalMonth}
            onChange={setFiscalMonth}
            className="mt-1.5 sm:max-w-[260px]"
            options={FISCAL_MONTHS}
            searchable={false}
          />
          <FieldError errors={state?.errors} name="fiscalYearStartMonth" />
          <p className="mt-1 text-[11px] text-slate-400">
            Agrupa el archivo y marca hasta cuándo hay que conservar las facturas; no cambia los números de registro.
          </p>
          {regroups && (
            <p role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              Cambiarlo reagrupa todo el archivo de este cliente y su «conservar hasta». No cambia los números de registro.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="client-contact" className="block text-[13px] font-medium text-slate-700">Persona de contacto</label>
          <input id="client-contact" name="contactName" defaultValue={initial.contactName ?? ""} className="input mt-1.5 w-full" placeholder="María García" />
          <FieldError errors={state?.errors} name="contactName" />
        </div>

        <div>
          <label htmlFor="client-phone" className="block text-[13px] font-medium text-slate-700">Teléfono</label>
          <input id="client-phone" name="phone" type="tel" defaultValue={initial.phone ?? ""} className="input mt-1.5 w-full" placeholder="612 345 678" />
          <FieldError errors={state?.errors} name="phone" />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="client-notes" className="block text-[13px] font-medium text-slate-700">
            Notas internas <span className="font-normal text-slate-400">(solo las ve la asesoría)</span>
          </label>
          <textarea
            id="client-notes"
            name="notes"
            rows={4}
            defaultValue={initial.notes ?? ""}
            className="input mt-1.5 w-full resize-y"
            placeholder="Ej.: sube las facturas a final de mes; las de Amazon van siempre a la 629."
          />
          <FieldError errors={state?.errors} name="notes" />
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Guardando..." : "Guardar cambios"}
        </button>
      </div>
    </form>
  );
}
