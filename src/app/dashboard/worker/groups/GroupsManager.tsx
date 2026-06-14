"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, Save, X, Users } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { createGroup, updateGroup, deleteGroup } from "./actions";

type Client = { id: string; name: string; cif: string };
type Group = { id: string; name: string; clientIds: string[] };

export function GroupsManager({ clients, groups }: { clients: Client[]; groups: Group[] }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  if (clients.length < 2) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-[13px] text-slate-500">
        Necesitas al menos 2 empresas accesibles para crear un grupo.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {!creating && editing === null && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" /> Nuevo grupo
        </button>
      )}

      {creating && (
        <GroupForm
          clients={clients}
          onClose={() => setCreating(false)}
          onSubmit={(name, ids) => createGroup(name, ids)}
        />
      )}

      <div className="space-y-3">
        {groups.map((g) =>
          editing === g.id ? (
            <GroupForm
              key={g.id}
              clients={clients}
              initialName={g.name}
              initialIds={g.clientIds}
              onClose={() => setEditing(null)}
              onSubmit={(name, ids) => updateGroup(g.id, name, ids)}
            />
          ) : (
            <GroupRow
              key={g.id}
              group={g}
              nameById={nameById}
              onEdit={() => setEditing(g.id)}
            />
          ),
        )}
        {groups.length === 0 && !creating && (
          <p className="text-[13px] text-slate-400">Aún no hay grupos.</p>
        )}
      </div>
    </div>
  );
}

function GroupRow({
  group,
  nameById,
  onEdit,
}: {
  group: Group;
  nameById: Map<string, string>;
  onEdit: () => void;
}) {
  const { success, error: toastError } = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();

  const onDelete = () => {
    if (!confirm(`¿Eliminar el grupo "${group.name}"?`)) return;
    start(async () => {
      const res = await deleteGroup(group.id);
      if (res?.error) toastError(res.error);
      else { success("Grupo eliminado"); router.refresh(); }
    });
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-400" />
          <span className="text-[14px] font-semibold text-slate-800">{group.name}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {group.clientIds.map((cid) => (
            <span key={cid} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {nameById.get(cid) ?? cid}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button type="button" onClick={onEdit} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-50">
          Editar
        </button>
        <button type="button" onClick={onDelete} disabled={pending} title="Eliminar grupo"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-50">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function GroupForm({
  clients,
  initialName = "",
  initialIds = [],
  onClose,
  onSubmit,
}: {
  clients: Client[];
  initialName?: string;
  initialIds?: string[];
  onClose: () => void;
  onSubmit: (name: string, clientIds: string[]) => Promise<{ ok?: boolean; error?: string } | null>;
}) {
  const { success, error: toastError } = useToast();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialIds));
  const [pending, start] = useTransition();

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const submit = () => {
    start(async () => {
      const res = await onSubmit(name, [...selected]);
      if (res?.error) toastError(res.error);
      else { success("Grupo guardado"); onClose(); router.refresh(); }
    });
  };

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nombre del grupo (ej. Restaurantes Pepe)"
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
      <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {clients.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700">
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600" />
            <span className="truncate" title={`${c.name} (${c.cif})`}>{c.name}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={submit} disabled={pending || !name.trim() || selected.size < 2}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Guardar grupo
        </button>
        <button type="button" onClick={onClose} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-600 hover:bg-slate-50">
          <X className="h-3.5 w-3.5" /> Cancelar
        </button>
        {selected.size < 2 && <span className="text-[11px] text-slate-400">Selecciona al menos 2 empresas</span>}
      </div>
    </div>
  );
}
