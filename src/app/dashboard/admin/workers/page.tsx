import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Users, Plus, Search, MoreHorizontal, Building2, Shield } from "lucide-react";
import Link from "next/link";

const AVATAR_COLORS = [
  "bg-violet-100 text-violet-700",
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-orange-100 text-orange-700",
  "bg-rose-100 text-rose-700",
];

function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h += c.charCodeAt(0);
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default async function WorkersPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const workers = await prisma.user.findMany({
    where: { role: "WORKER", advisoryFirmId: firmId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { assignedClients: true } } },
  }).catch(() => []);

  return (
    <div>
      <PageHeader
        title="Gestión de gestores"
        description={`${workers.length} gestor${workers.length !== 1 ? "es" : ""} registrado${workers.length !== 1 ? "s" : ""}`}
        action={
          <Link
            href="/dashboard/admin/workers/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Nuevo gestor
          </Link>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar gestores..."
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] placeholder-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {workers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Sin gestores"
            description="Añade gestores para asignarlos a clientes."
            action={
              <Link
                href="/dashboard/admin/workers/new"
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                Nuevo gestor
              </Link>
            }
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {["Gestor", "Email", "Rol", "Clientes asignados", "Acciones"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {workers.map((worker) => (
                <tr key={worker.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${avatarColor(worker.name)}`}>
                        {worker.name.split(" ").map(n => n[0]).join("").slice(0,2)}
                      </div>
                      <p className="text-[13px] font-semibold text-slate-800">{worker.name}</p>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[13px] text-slate-500">{worker.email}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-[13px] text-slate-500">
                      <Shield className="h-3.5 w-3.5 text-slate-300" />
                      Gestor
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5 text-[13px] text-slate-600">
                      <Building2 className="h-3.5 w-3.5 text-slate-400" />
                      {worker._count.assignedClients} cliente{worker._count.assignedClients !== 1 ? "s" : ""}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <button className="text-[13px] font-medium text-blue-600 hover:text-blue-700">
                        Gestionar
                      </button>
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
