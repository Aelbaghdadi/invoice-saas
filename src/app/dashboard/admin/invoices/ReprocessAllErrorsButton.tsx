"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { reprocessAllOcrErrors } from "./actions";

/** `count` son todas las de la asesoria en Error OCR, que es lo que reprocesa
 *  la accion. Con filtros activos se dice en el boton: no los respeta. */
export function ReprocessAllErrorsButton({ count, filtered = false }: { count: number; filtered?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      const res = await reprocessAllOcrErrors();
      if (res.error) {
        setToast({ msg: res.error, type: "err" });
        return;
      }
      setToast({ msg: `${res.count} ${res.count === 1 ? "factura puesta" : "facturas puestas"} en cola para reprocesar`, type: "ok" });
      router.refresh();
    });
  }

  return (
    <div className="mb-4 flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={isPending || count === 0}
        className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
        {isPending
          ? "Reprocesando..."
          : filtered
            ? `Reprocesar todas las de la asesoría (${count})`
            : `Reprocesar todas (${count})`}
      </button>
      {toast && (
        <span className={`text-[12px] font-medium ${toast.type === "ok" ? "text-emerald-600" : "text-red-600"}`}>
          {toast.msg}
        </span>
      )}
    </div>
  );
}
