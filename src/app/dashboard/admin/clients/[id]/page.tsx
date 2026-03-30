import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ChevronLeft, Mail, Building2, FileText, Users } from "lucide-react";
import Link from "next/link";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En análisis", variant: "yellow" },
  ANALYZED:  { label: "Analizada",   variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",   variant: "red" },
  VALIDATED: { label: "Validada",    variant: "green" },
  REJECTED:  { label: "Rechazada",   variant: "red" },
  EXPORTED:  { label: "Exportada",   variant: "slate" },
};

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      invoices: { orderBy: { createdAt: "desc" }, take: 10 },
      assignedWorkers: { include: { worker: true } },
    },
  });
  if (!client) notFound();

  const stats = [
    { label: "Total facturas", value: client.invoices.length, icon: FileText },
    { label: "Gestores asignados", value: client.assignedWorkers.length, icon: Users },
    { label: "Pendientes", value: client.invoices.filter(i => ["UPLOADED","ANALYZING","ANALYZED","OCR_ERROR"].includes(i.status)).length, icon: Building2 },
  ];

  return (
    <div>
      <Link href="/dashboard/admin/clients" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Volver a clientes
      </Link>

      <PageHeader title={client.name} description={`CIF: ${client.cif}`} />

      {/* Info card */}
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
        {/* Client info */}
        <div className="col-span-1 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Información del cliente</h2>
          <div className="space-y-3 text-[13px]">
            <div className="flex items-center gap-2 text-slate-500">
              <Mail className="h-4 w-4 text-slate-300" />
              {client.email}
            </div>
            <div className="flex items-center gap-2 text-slate-500">
              <Building2 className="h-4 w-4 text-slate-300" />
              {client.accountingProgram ?? <span className="italic text-slate-300">Sin programa</span>}
            </div>
          </div>

          <h3 className="mb-3 mt-6 text-[13px] font-semibold text-slate-700">Gestores asignados</h3>
          {client.assignedWorkers.length === 0 ? (
            <p className="text-[12px] text-slate-400">Sin gestores asignados.</p>
          ) : (
            <ul className="space-y-2">
              {client.assignedWorkers.map((a) => (
                <li key={a.workerId} className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-700">
                    {a.worker.name.split(" ").map(n => n[0]).join("").slice(0,2)}
                  </div>
                  <span className="text-[13px] text-slate-600">{a.worker.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Invoices */}
        <div className="col-span-2 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-[14px] font-semibold text-slate-800">Facturas</h2>
          </div>
          {client.invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="mb-3 h-8 w-8 text-slate-200" />
              <p className="text-[13px] text-slate-400">Sin facturas subidas.</p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  {["Archivo", "Período", "Tipo", "Estado", ""].map((h) => (
                    <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {client.invoices.map((inv) => {
                  const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-slate-300" />
                          <span className="text-[13px] text-slate-700 truncate max-w-[160px]">{inv.filename}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-[13px] text-slate-500">
                        {new Date(0, inv.periodMonth - 1).toLocaleString("es", { month: "short" })} {inv.periodYear}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                          {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                        </Badge>
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={s.variant}>{s.label}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        <Link href={`/dashboard/admin/invoices/${inv.id}`} className="text-[13px] font-medium text-blue-600 hover:text-blue-700">
                          Ver
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
