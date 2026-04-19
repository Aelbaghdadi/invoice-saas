import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { ChevronLeft, Mail, Users, FileText, Calendar } from "lucide-react";
import Link from "next/link";
import { PENDING_WORK } from "@/lib/invoiceStatuses";
import { AssignmentsPanel } from "./AssignmentsPanel";
import { DeleteWorkerButton } from "./DeleteWorkerButton";

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

export default async function WorkerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const { id } = await params;

  const worker = await prisma.user.findFirst({
    where: { id, role: "WORKER", advisoryFirmId: firmId },
    include: {
      assignedClients: { include: { client: true } },
    },
  });
  if (!worker) notFound();

  const allClients = await prisma.client.findMany({
    where: { advisoryFirmId: firmId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, cif: true },
  });

  const assignedClientIds = worker.assignedClients.map((a) => a.clientId);

  // Invoice stats across assigned clients
  const [totalInvoices, pendingInvoices] = assignedClientIds.length
    ? await Promise.all([
        prisma.invoice.count({ where: { clientId: { in: assignedClientIds } } }),
        prisma.invoice.count({
          where: { clientId: { in: assignedClientIds }, status: { in: PENDING_WORK } },
        }),
      ])
    : [0, 0];

  const stats = [
    { label: "Clientes asignados", value: assignedClientIds.length, icon: Users },
    { label: "Facturas totales", value: totalInvoices, icon: FileText },
    { label: "Pendientes", value: pendingInvoices, icon: Calendar },
  ];

  return (
    <div>
      <Link
        href="/dashboard/admin/workers"
        className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" />
        Volver a gestores
      </Link>

      <PageHeader
        title={worker.name}
        description={worker.email}
        action={<DeleteWorkerButton workerId={worker.id} disabled={assignedClientIds.length > 0} />}
      />

      <div className="mb-6 grid grid-cols-3 gap-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-slate-400">
                <Icon className="h-4 w-4" />
                <span className="text-[12px] font-medium uppercase tracking-wide">{s.label}</span>
              </div>
              <p className="mt-2 text-2xl font-bold text-slate-900">{s.value}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-1 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Información</h2>
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full text-[12px] font-bold ${avatarColor(worker.name)}`}>
                {worker.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </div>
              <div>
                <p className="font-medium text-slate-800">{worker.name}</p>
                <p className="text-[11px] text-slate-400">Gestor</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-slate-500">
              <Mail className="h-4 w-4 text-slate-300" />
              {worker.email}
            </div>
            <div className="flex items-center gap-2 text-slate-500">
              <Calendar className="h-4 w-4 text-slate-300" />
              Alta: {new Date(worker.createdAt).toLocaleDateString("es-ES")}
            </div>
          </div>
        </div>

        <div className="col-span-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Clientes asignados</h2>
          <AssignmentsPanel
            workerId={worker.id}
            allClients={allClients}
            assignedIds={assignedClientIds}
          />
        </div>
      </div>
    </div>
  );
}
