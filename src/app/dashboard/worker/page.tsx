import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Building2, Clock, CheckCircle2, FileText, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import Link from "next/link";
import { PENDING_WORK } from "@/lib/invoiceStatuses";

export default async function WorkerDashboard() {
  const session = await auth();

  const assignments = await prisma.workerClientAssignment
    .findMany({
      where: { workerId: session!.user.id },
      include: {
        client: {
          include: {
            invoices: {
              orderBy: { createdAt: "desc" },
              take: 50,
            },
          },
        },
      },
    })
    .catch(() => []);

  const pendingInvoices = assignments.reduce(
    (acc, a) =>
      acc +
      a.client.invoices.filter(
        (i) => PENDING_WORK.includes(i.status)
      ).length,
    0
  );

  const validatedToday = assignments.reduce(
    (acc, a) =>
      acc +
      a.client.invoices.filter((i) => {
        const today = new Date().toISOString().slice(0, 10);
        return (
          i.status === "VALIDATED" &&
          i.updatedAt.toISOString().slice(0, 10) === today
        );
      }).length,
    0
  );

  const stats = [
    { label: "Clientes asignados", value: assignments.length,  icon: Building2,    color: "text-blue-600",   bg: "bg-blue-50" },
    { label: "Facturas pendientes",value: pendingInvoices,     icon: Clock,        color: "text-yellow-600", bg: "bg-yellow-50" },
    { label: "Validadas hoy",      value: validatedToday,      icon: CheckCircle2, color: "text-green-600",  bg: "bg-green-50" },
  ];

  const recentInvoices = assignments
    .flatMap((a) =>
      a.client.invoices.map((inv) => ({ ...inv, clientName: a.client.name }))
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 8);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-slate-900">
          Bienvenido, {session?.user?.name}
        </h1>
        <p className="mt-0.5 text-[13px] text-slate-500">
          Resumen de las facturas de tus clientes asignados.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${bg}`}>
              <Icon className={`h-4 w-4 ${color}`} />
            </div>
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            <p className="mt-0.5 text-[12px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-5 gap-5">
        {/* Clients with pending work */}
        <div className="col-span-2 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="text-[14px] font-semibold text-slate-800">Clientes</h2>
            <Link
              href="/dashboard/worker/clients"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todos <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {assignments.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <Building2 className="mx-auto mb-2 h-8 w-8 text-slate-200" />
              <p className="text-[12px] text-slate-400">Sin clientes asignados</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {assignments.slice(0, 6).map((a) => {
                const pending = a.client.invoices.filter(
                  (i) => PENDING_WORK.includes(i.status)
                ).length;
                return (
                  <li key={a.clientId} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-[13px] font-medium text-slate-700">{a.client.name}</p>
                      <p className="text-[11px] text-slate-400">{a.client.cif}</p>
                    </div>
                    {pending > 0 && (
                      <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-[11px] font-semibold text-yellow-700">
                        {pending} pendiente{pending !== 1 ? "s" : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Recent invoices */}
        <div className="col-span-3 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="text-[14px] font-semibold text-slate-800">
              Facturas recientes
            </h2>
            <Link
              href="/dashboard/worker/invoices"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todas <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {recentInvoices.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <FileText className="mx-auto mb-2 h-8 w-8 text-slate-200" />
              <p className="text-[12px] text-slate-400">Sin facturas recientes</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {recentInvoices.map((inv) => {
                const statusColors: Record<string, string> = {
                  UPLOADED: "bg-blue-100 text-blue-700",
                  ANALYZING: "bg-yellow-100 text-yellow-700",
                  ANALYZED: "bg-yellow-100 text-yellow-700",
                  OCR_ERROR: "bg-red-100 text-red-700",
                  VALIDATED: "bg-green-100 text-green-700",
                  REJECTED: "bg-red-100 text-red-700",
                  EXPORTED: "bg-slate-100 text-slate-700",
                  PENDING_REVIEW: "bg-blue-100 text-blue-700",
                  NEEDS_ATTENTION: "bg-yellow-100 text-yellow-700",
                };
                const statusLabels: Record<string, string> = {
                  UPLOADED: "Subida", ANALYZING: "Análisis",
                  ANALYZED: "Analizada", OCR_ERROR: "Error OCR",
                  VALIDATED: "Validada", REJECTED: "Rechazada",
                  EXPORTED: "Exportada",
                  PENDING_REVIEW: "Pte. revisión",
                  NEEDS_ATTENTION: "Con incidencias",
                };
                return (
                  <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                      <FileText className="h-3.5 w-3.5 text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-slate-700">{inv.filename}</p>
                      <p className="text-[11px] text-slate-400">{inv.clientName}</p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColors[inv.status] ?? ""}`}>
                      {statusLabels[inv.status] ?? inv.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
