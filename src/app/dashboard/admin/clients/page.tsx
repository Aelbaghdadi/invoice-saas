import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Building2, Plus, Search, MoreHorizontal, Users } from "lucide-react";
import Link from "next/link";

function clientInitials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-violet-100 text-violet-700",
  "bg-green-100 text-green-700",
  "bg-orange-100 text-orange-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
];

function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h += c.charCodeAt(0);
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default async function ClientsPage() {
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { invoices: true, assignedWorkers: true } },
    },
  }).catch(() => []);

  return (
    <div>
      <PageHeader
        title="Gestión de clientes"
        description={`${clients.length} cliente${clients.length !== 1 ? "s" : ""} registrado${clients.length !== 1 ? "s" : ""}`}
        action={
          <Link
            href="/dashboard/admin/clients/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Nuevo cliente
          </Link>
        }
      />

      {/* Search + filters */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar clientes..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] text-slate-700 placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {clients.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Sin clientes"
            description="Añade tu primer cliente para comenzar."
            action={
              <Link
                href="/dashboard/admin/clients/new"
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Nuevo cliente
              </Link>
            }
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {["Cliente", "CIF", "Software contable", "Facturas", "Gestores", "Acciones"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {clients.map((client) => (
                <tr key={client.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${avatarColor(client.name)}`}>
                        {clientInitials(client.name)}
                      </div>
                      <div>
                        <p className="text-[13px] font-semibold text-slate-800">{client.name}</p>
                        <p className="text-[11px] text-slate-400">{client.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[13px] font-mono text-slate-600">{client.cif}</td>
                  <td className="px-5 py-3.5 text-[13px] text-slate-500">
                    {client.accountingProgram ?? (
                      <span className="italic text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-[13px] text-slate-600">
                      <Building2 className="h-3.5 w-3.5 text-slate-400" />
                      {client._count.invoices}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-[13px] text-slate-600">
                      <Users className="h-3.5 w-3.5 text-slate-400" />
                      {client._count.assignedWorkers}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/dashboard/admin/clients/${client.id}`}
                        className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                      >
                        Ver
                      </Link>
                      <button className="rounded p-1 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
