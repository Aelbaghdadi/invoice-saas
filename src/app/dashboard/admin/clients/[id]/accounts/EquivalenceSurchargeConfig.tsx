"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";
import { updateEquivalenceSurcharge } from "./actions";

type Props = {
  clientId: string;
  initialEnabled: boolean;
};

/**
 * Marca a este cliente como minorista acogido a Recargo de Equivalencia.
 * Con el flag activo, sus facturas de compra sugieren automáticamente % y
 * cuota de recargo (mapeo habitual según el IVA) al procesarlas; sin él,
 * el sistema nunca inventa recargo por el simple hecho de que el IVA sea
 * 21/10/4.
 */
export function EquivalenceSurchargeConfig({ clientId, initialEnabled }: Props) {
  const action = updateEquivalenceSurcharge.bind(null, clientId);
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
    <form
      action={formAction}
      onChange={(e) => (e.currentTarget as HTMLFormElement).requestSubmit()}
      className="mb-6 flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4"
    >
      <div>
        <h3 className="text-[13px] font-semibold text-slate-800">Recargo de Equivalencia</h3>
        <p className="mt-0.5 text-[12px] text-slate-500">
          Cliente minorista acogido a RE: sus compras sugieren automáticamente % y cuota de recargo
          (21→5,2 / 10→1,4 / 4→0,5), revisable en cada factura.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        {saved && <Check className="h-3.5 w-3.5 text-green-600" />}
        <label className="relative inline-flex cursor-pointer items-center">
          <input
            type="checkbox"
            name="equivalenceSurchargeCustomer"
            defaultChecked={initialEnabled}
            className="peer sr-only"
          />
          <div className="peer h-5 w-9 rounded-full bg-slate-200 transition-colors peer-checked:bg-blue-600 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-4" />
        </label>
      </div>
      {state?.error && <p className="text-[12px] text-red-600">{state.error}</p>}
    </form>
  );
}
