"use client";

import { useState, useTransition } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { deleteWorker } from "../actions";

export function DeleteWorkerButton({ workerId, disabled }: { workerId: string; disabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    if (disabled) return;
    if (!confirm("¿Eliminar este gestor? Esta acción no se puede deshacer.")) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteWorker(workerId);
      if (res && "error" in res && res.error) setError(res.error);
    });
  };

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={disabled || pending}
        title={disabled ? "Desasigna todos los clientes antes de eliminar" : undefined}
        className="flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-[13px] font-medium text-red-600 shadow-sm transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        Eliminar gestor
      </button>
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
