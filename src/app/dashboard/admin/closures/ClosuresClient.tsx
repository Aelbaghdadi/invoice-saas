"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { Select } from "@/components/ui/Select";
import { Lock, Loader2 } from "lucide-react";
import { closePeriod } from "./actions";

const MONTHS = [
  { value: "1", label: "Enero" },
  { value: "2", label: "Febrero" },
  { value: "3", label: "Marzo" },
  { value: "4", label: "Abril" },
  { value: "5", label: "Mayo" },
  { value: "6", label: "Junio" },
  { value: "7", label: "Julio" },
  { value: "8", label: "Agosto" },
  { value: "9", label: "Septiembre" },
  { value: "10", label: "Octubre" },
  { value: "11", label: "Noviembre" },
  { value: "12", label: "Diciembre" },
];

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
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Cliente
          </label>
          <Select
            value={clientId}
            onChange={setClientId}
            options={clients.map((c) => ({ value: c.id, label: `${c.name} (${c.cif})` }))}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Mes
          </label>
          <Select value={month} onChange={setMonth} options={MONTHS} />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Año
          </label>
          <Select value={year} onChange={setYear} options={YEARS} />
        </div>
        <div className="flex items-end">
          <button
            onClick={handleClose}
            disabled={isPending || !clientId}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            Cerrar periodo
          </button>
        </div>
      </div>
    </div>
  );
}
