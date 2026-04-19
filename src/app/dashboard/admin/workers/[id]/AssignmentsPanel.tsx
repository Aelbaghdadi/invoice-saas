"use client";

import { useState, useTransition } from "react";
import { Search, Check, Loader2 } from "lucide-react";
import { assignClientToWorker, unassignClientFromWorker } from "../actions";

type ClientRow = { id: string; name: string; cif: string };

export function AssignmentsPanel({
  workerId,
  allClients,
  assignedIds,
}: {
  workerId: string;
  allClients: ClientRow[];
  assignedIds: string[];
}) {
  const [assigned, setAssigned] = useState<Set<string>>(new Set(assignedIds));
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const filtered = allClients.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || c.cif.toLowerCase().includes(q);
  });

  const toggle = (clientId: string) => {
    const isAssigned = assigned.has(clientId);
    setBusy(clientId);
    setError(null);
    const next = new Set(assigned);
    if (isAssigned) next.delete(clientId);
    else next.add(clientId);
    setAssigned(next);

    startTransition(async () => {
      const res = isAssigned
        ? await unassignClientFromWorker(workerId, clientId)
        : await assignClientToWorker(workerId, clientId);
      setBusy(null);
      if (res && "error" in res && res.error) {
        // revert
        const revert = new Set(assigned);
        setAssigned(revert);
        setError(res.error);
      }
    });
  };

  return (
    <div>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar cliente por nombre o CIF..."
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        />
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
      )}

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-slate-400">Sin clientes.</p>
      ) : (
        <ul className="divide-y divide-slate-50 rounded-lg border border-slate-100">
          {filtered.map((c) => {
            const isAssigned = assigned.has(c.id);
            const isBusy = busy === c.id;
            return (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-slate-800">{c.name}</p>
                  <p className="text-[11px] text-slate-400">{c.cif}</p>
                </div>
                <button
                  onClick={() => toggle(c.id)}
                  disabled={isBusy}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 ${
                    isAssigned
                      ? "border border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {isBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isAssigned ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : null}
                  {isAssigned ? "Asignado" : "Asignar"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
