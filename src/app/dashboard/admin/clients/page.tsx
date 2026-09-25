import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Building2, FileText, Plus, Search, Users, X } from "lucide-react";
import Link from "next/link";
import Form from "next/form";
import { matchesSearch } from "@/lib/listing";

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

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const { q: rawQuery } = await searchParams;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";

  const clients = await prisma.client.findMany({
    where: { advisoryFirmId: firmId, isUnclassifiedBucket: false },
    orderBy: { name: "asc" },
    include: {
      _count: { select: { invoices: true, assignedWorkers: true } },
    },
  }).catch(() => []);

  // Se filtra en memoria: son los clientes de una asesoria (decenas) y asi
  // la busqueda ignora tildes igual que el resto de listados.
  const visibleClients = clients.filter((c) => matchesSearch([c.name, c.cif, c.email], query));

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
        <Form action="/dashboard/admin/clients" className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          {/* key: al quitar la busqueda el campo tiene que vaciarse aunque
              se hubiera escrito en el. */}
          <input
            key={query}
            type="search"
            name="q"
            defaultValue={query}
            aria-label="Buscar clientes"
            placeholder="Buscar por nombre, CIF o email…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-[13px] text-slate-700 placeholder-slate-400 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-100"
          />
        </Form>
        {query && (
          <Link
            href="/dashboard/admin/clients"
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[12px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3.5 w-3.5" />
            Quitar búsqueda
          </Link>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {clients.length > 0 && visibleClients.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Sin resultados"
            description={`Ningún cliente coincide con «${query}».`}
          />
        ) : clients.length === 0 ? (
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
                {[
                  { label: "Cliente", numeric: false },
                  { label: "CIF", numeric: false },
                  { label: "Software contable", numeric: false },
                  { label: "Facturas", numeric: true },
                  { label: "Gestores", numeric: true },
                  { label: "Acciones", numeric: false },
                ].map((h) => (
                  <th
                    key={h.label}
                    className={`px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${h.numeric ? "text-right" : "text-left"}`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {visibleClients.map((client) => (
                <tr key={client.id} className="group hover:bg-slate-50/60">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${avatarColor(client.name)}`}>
                        {clientInitials(client.name)}
                      </div>
                      <div>
                        <p className="text-[13px] font-semibold text-slate-800">{client.name}</p>
                        <p className="text-[11px] text-slate-400">{client.email ?? <span className="italic text-slate-300">Sin acceso al portal</span>}</p>
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
                    <div className="flex items-center justify-end gap-1.5 text-[13px] tabular-nums text-slate-600">
                      <FileText className="h-3.5 w-3.5 text-slate-400" />
                      {client._count.invoices.toLocaleString("es-ES")}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center justify-end gap-1.5 text-[13px] tabular-nums text-slate-600">
                      <Users className="h-3.5 w-3.5 text-slate-400" />
                      {client._count.assignedWorkers}
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/dashboard/admin/clients/${client.id}`}
                      className="text-[13px] font-medium text-blue-600 hover:text-blue-700"
                    >
                      Ver
                    </Link>
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
