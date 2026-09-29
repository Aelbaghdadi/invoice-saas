"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import { Lock, Loader2 } from "lucide-react";
import { MONTH_OPTIONS } from "@/lib/period";
import { closePeriod } from "./actions";

const YEARS = Array.from({ length: 5 }, (_, i) => {
  const y = new Date().getFullYear() - i;
  return { value: String(y), label: String(y) };
});

type Props = {
  clients: { id: string; name: string; cif: string }[];
};

export function ClosuresClient({ clients }: Props) {
  const now = new Date();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const handleClose = () => {
    const fd = new FormData();
    fd.set("clientId", clientId);
    fd.set("month", month);
    fd.set("year", year);

    startTransition(async () => {
      const res = await closePeriod(fd);
      if (res.error) {
        toastError(res.error);
      } else {
        success("Periodo cerrado correctamente");
        router.refresh();
      }
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-[14px] font-semibold text-slate-800">
        Cerrar periodo
      </h2>
      <div className="grid grid-cols-4 gap-4">
        <div>
          <label htmlFor="cierre-cliente" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Cliente
          </label>
          <Select
            id="cierre-cliente"
            value={clientId}
            onChange={setClientId}
            options={clients.map((c) => ({ value: c.id, label: `${c.name} (${c.cif})` }))}
          />
        </div>
        <div>
          <label htmlFor="cierre-mes" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Mes
          </label>
          <Select id="cierre-mes" value={month} onChange={setMonth} options={MONTH_OPTIONS} />
        </div>
        <div>
          <label htmlFor="cierre-anio" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Año
          </label>
          <Select id="cierre-anio" value={year} onChange={setYear} options={YEARS} />
        </div>
        <div className="flex items-end">
          {/* Mismo verde y candado que "Cerrar periodo" en Lotes: el rojo se
              reserva para lo destructivo (rechazar, eliminar). */}
          <button
            type="button"
            onClick={handleClose}
            disabled={isPending || !clientId}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            Cerrar periodo
          </button>
        </div>
      </div>
    </div>
  );
}
