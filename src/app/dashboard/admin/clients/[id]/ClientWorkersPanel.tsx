"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { assignClientToWorker, unassignClientFromWorker } from "../../workers/actions";

type WorkerRow = { id: string; name: string; email: string };

/** Los gestores de la asesoria, con los asignados a este cliente marcados.
 *  Las acciones son las de la ficha del gestor, vistas desde el cliente. */
export function ClientWorkersPanel({ clientId, workers, assignedIds }: { clientId: string; workers: WorkerRow[]; assignedIds: string[] }) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedIds));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const toggle = (workerId: string) => {
    const was = assigned.has(workerId);
    setBusy(workerId);
    setError(null);
    const next = new Set(assigned);
    if (was) next.delete(workerId);
    else next.add(workerId);
    setAssigned(next);
    startTransition(async () => {
      const res = was ? await unassignClientFromWorker(workerId, clientId) : await assignClientToWorker(workerId, clientId);
      setBusy(null);
      if (res && "error" in res && res.error) {
        setAssigned(new Set(assigned));
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  if (workers.length === 0) {
    return <p className="text-[13px] text-slate-400">La asesoría aún no tiene gestores. Créalos en «Gestores».</p>;
  }

  return (
    <div>
      {error && <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>}
      <ul className="divide-y divide-slate-50 rounded-lg border border-slate-100">
        {workers.map((w) => {
          const isAssigned = assigned.has(w.id);
          const isBusy = busy === w.id;
          return (
            <li key={w.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-slate-800">{w.name}</p>
                <p className="truncate text-[11px] text-slate-400">{w.email}</p>
              </div>
              <button
                type="button"
                onClick={() => toggle(w.id)}
                disabled={isBusy}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 ${
                  isAssigned
                    ? "border border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isAssigned ? <Check className="h-3.5 w-3.5" /> : null}
                {isAssigned ? "Asignado" : "Asignar"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
