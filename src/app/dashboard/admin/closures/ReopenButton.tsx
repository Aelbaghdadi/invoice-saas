"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Unlock } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { reopenPeriod } from "./actions";

type Props = {
  closureId: string;
  /** Cliente y periodo, para el aviso: "Periodo reabierto: Panadería · Marzo 2026". */
  label: string;
};

/**
 * Reabrir un cierre. Antes era un formulario con la accion en linea: no se
 * bloqueaba mientras trabajaba y el resultado se tiraba, asi que un error no
 * se veia. Mismo patron que "Cerrar periodo" en Lotes.
 */
export function ReopenButton({ closureId, label }: Props) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const handleReopen = () => {
    const fd = new FormData();
    fd.set("closureId", closureId);
    startTransition(async () => {
      try {
        const res = await reopenPeriod(fd);
        if (res.error) {
          toastError(res.error);
          return;
        }
        success(`Periodo reabierto: ${label}`);
        router.refresh();
      } catch {
        toastError("No se pudo reabrir el periodo. Inténtalo de nuevo.");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleReopen}
      disabled={isPending}
      className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />}
      Reabrir
    </button>
  );
}
