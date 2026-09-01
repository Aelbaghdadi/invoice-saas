"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { reprocessAllOcrErrors } from "./actions";

export function ReprocessAllErrorsButton({ count }: { count: number }) {
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
      setToast({ msg: `${res.count} factura(s) puestas en cola para reprocesar`, type: "ok" });
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
        {isPending ? "Reprocesando..." : `Reprocesar todas (${count})`}
      </button>
      {toast && (
        <span className={`text-[12px] font-medium ${toast.type === "ok" ? "text-emerald-600" : "text-red-600"}`}>
          {toast.msg}
        </span>
      )}
    </div>
  );
}
