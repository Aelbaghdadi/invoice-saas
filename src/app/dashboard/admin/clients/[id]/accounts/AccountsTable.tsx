"use client";

import { useState, useTransition } from "react";
import { createAccountEntry, updateAccountEntry, deleteAccountEntry } from "./actions";
import { Plus, Pencil, Trash2, Check, X, Search, Loader2 } from "lucide-react";
import type { AccountEntry } from "@prisma/client";
import { useRouter } from "next/navigation";

type Props = {
  entries: AccountEntry[];
  clientId: string;
};

export function AccountsTable({ entries, clientId }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const filtered = entries.filter(
    (e) =>
      e.nif.toLowerCase().includes(search.toLowerCase()) ||
      e.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleCreate = (fd: FormData) => {
    setError(null);
    startTransition(async () => {
      const bound = createAccountEntry.bind(null, clientId, null);
      const res = await bound(fd);
      if (res?.error) {
        setError(res.error);
      } else {
        setShowAdd(false);
        router.refresh();
      }
    });
  };

  const handleUpdate = (entryId: string, fd: FormData) => {
    setError(null);
    startTransition(async () => {
      const bound = updateAccountEntry.bind(null, entryId, null);
      const res = await bound(fd);
      if (res?.error) {
        setError(res.error);
      } else {
        setEditId(null);
        router.refresh();
      }
    });
  };

  const handleDelete = (entryId: string) => {
    if (!confirm("Eliminar esta cuenta del plan?")) return;
    startTransition(async () => {
      await deleteAccountEntry(entryId);
      router.refresh();
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-300" />
          <input
            type="text"
            placeholder="Buscar por NIF o nombre..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-slate-200 py-2 pl-9 pr-4 text-[13px] focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
          />
        </div>
        <button
          type="button"
          onClick={() => { setShowAdd(true); setError(null); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-medium text-white shadow-sm hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          Añadir cuenta
        </button>
      </div>

      {error && (
        <div className="border-b border-red-100 bg-red-50 px-5 py-2 text-[13px] text-red-700">{error}</div>
      )}

      {/* Table */}
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-100">
            {["NIF", "Nombre / Razón Social", "Cuenta Proveedor", "Cuenta Gasto", "IVA %", ""].map((h) => (
              <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {/* Add row */}
          {showAdd && (
            <InlineForm
              onSubmit={handleCreate}
              onCancel={() => setShowAdd(false)}
              isPending={isPending}
            />
          )}

          {filtered.length === 0 && !showAdd ? (
            <tr>
              <td colSpan={6} className="px-5 py-12 text-center text-[13px] text-slate-400">
                {entries.length === 0
                  ? "Sin cuentas registradas. Importa un Excel o añade cuentas manualmente."
                  : "No se encontraron resultados."}
              </td>
            </tr>
          ) : (
            filtered.map((entry) =>
              editId === entry.id ? (
                <InlineForm
                  key={entry.id}
                  initial={entry}
                  onSubmit={(fd) => handleUpdate(entry.id, fd)}
                  onCancel={() => setEditId(null)}
                  isPending={isPending}
                />
              ) : (
                <tr key={entry.id} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3 text-[13px] font-mono text-slate-700">{entry.nif}</td>
                  <td className="px-5 py-3 text-[13px] text-slate-700">{entry.name}</td>
                  <td className="px-5 py-3 text-[13px] font-mono text-slate-600">{entry.supplierAccount}</td>
                  <td className="px-5 py-3 text-[13px] font-mono text-slate-600">{entry.expenseAccount}</td>
                  <td className="px-5 py-3 text-[13px] text-slate-500">
                    {entry.defaultVatRate != null ? `${entry.defaultVatRate}%` : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => { setEditId(entry.id); setError(null); }}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        title="Editar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(entry.id)}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                        title="Eliminar"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )
          )}
        </tbody>
      </table>

      {entries.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-3 text-[12px] text-slate-400">
          {entries.length} cuenta{entries.length !== 1 ? "s" : ""} en total
        </div>
      )}
    </div>
  );
}

// ─── Inline form for add/edit ───────────────────────────────────────────────

function InlineForm({
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: AccountEntry;
  onSubmit: (fd: FormData) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    onSubmit(fd);
  };

  const inputCls =
    "w-full rounded border border-slate-200 px-2 py-1.5 text-[13px] font-mono focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300";

  return (
    <tr className="bg-blue-50/40">
      <td className="px-5 py-2">
        <form id="account-form" onSubmit={handleSubmit}>
          <input name="nif" defaultValue={initial?.nif ?? ""} placeholder="B12345678" className={inputCls} required />
        </form>
      </td>
      <td className="px-5 py-2">
        <input form="account-form" name="name" defaultValue={initial?.name ?? ""} placeholder="Razón Social" className={inputCls} required />
      </td>
      <td className="px-5 py-2">
        <input form="account-form" name="supplierAccount" defaultValue={initial?.supplierAccount ?? ""} placeholder="400.00001" className={inputCls} required />
      </td>
      <td className="px-5 py-2">
        <input form="account-form" name="expenseAccount" defaultValue={initial?.expenseAccount ?? ""} placeholder="629.00000" className={inputCls} required />
      </td>
      <td className="px-5 py-2">
        <input form="account-form" name="defaultVatRate" type="number" step="0.01" defaultValue={initial?.defaultVatRate?.toString() ?? ""} placeholder="21" className={inputCls} />
      </td>
      <td className="px-5 py-2">
        <div className="flex items-center gap-1">
          <button
            form="account-form"
            type="submit"
            disabled={isPending}
            className="rounded p-1 text-green-600 hover:bg-green-50"
            title="Guardar"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-slate-400 hover:bg-slate-100"
            title="Cancelar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}
