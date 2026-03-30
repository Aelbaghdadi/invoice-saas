import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@prisma/client";
import { FileText, Clock, CheckCircle2, Upload, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import Link from "next/link";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",       variant: "blue" },
  ANALYZING: { label: "En análisis",  variant: "yellow" },
  ANALYZED:  { label: "Analizada",    variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",    variant: "red" },
  VALIDATED: { label: "Validada",     variant: "green" },
  REJECTED:  { label: "Rechazada",    variant: "red" },
  EXPORTED:  { label: "Exportada",    variant: "slate" },
};

export default async function ClientDashboard() {
  const session = await auth();

  const client = await prisma.client
    .findUnique({
      where: { userId: session!.user.id },
      include: {
        invoices: { orderBy: { createdAt: "desc" }, take: 6 },
      },
    })
    .catch(() => null);

  const total     = client ? await prisma.invoice.count({ where: { clientId: client.id } }).catch(() => 0) : 0;
  const pending   = client ? await prisma.invoice.count({ where: { clientId: client.id, status: { in: [InvoiceStatus.UPLOADED, InvoiceStatus.ANALYZING, InvoiceStatus.ANALYZED, InvoiceStatus.OCR_ERROR] } } }).catch(() => 0) : 0;
  const validated = client ? await prisma.invoice.count({ where: { clientId: client.id, status: InvoiceStatus.VALIDATED } }).catch(() => 0) : 0;

  const stats = [
    { label: "Total facturas",  value: total,     icon: FileText,    color: "text-blue-600",   bg: "bg-blue-50" },
    { label: "En proceso",      value: pending,   icon: Clock,       color: "text-yellow-600", bg: "bg-yellow-50" },
    { label: "Validadas",       value: validated, icon: CheckCircle2,color: "text-green-600",  bg: "bg-green-50" },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-slate-900">
          Bienvenido, {session?.user?.name}
        </h1>
        <p className="mt-0.5 text-[13px] text-slate-500">
          Aquí tienes el resumen de tus facturas.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg ${bg}`}>
              <Icon className={`h-4.5 w-4.5 ${color}`} />
            </div>
            <p className="text-2xl font-bold text-slate-900">{value}</p>
            <p className="mt-0.5 text-[12px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      {/* Upload CTA */}
      <div className="mt-6">
        <Link
          href="/dashboard/client/upload"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700"
        >
          <Upload className="h-4 w-4" />
          Subir facturas
        </Link>
      </div>

      {/* Recent invoices */}
      {client?.invoices && client.invoices.length > 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 className="text-[14px] font-semibold text-slate-800">
              Facturas recientes
            </h2>
            <Link
              href="/dashboard/client/invoices"
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700"
            >
              Ver todas <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <ul className="divide-y divide-slate-50">
            {client.invoices.map((invoice) => {
              const s = STATUS_BADGE[invoice.status] ?? STATUS_BADGE.UPLOADED;
              const monthName = new Date(0, invoice.periodMonth - 1).toLocaleString("es", { month: "short" });
              return (
                <li key={invoice.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                    <FileText className="h-3.5 w-3.5 text-slate-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-slate-700">
                      {invoice.filename}
                    </p>
                    <p className="text-[11px] capitalize text-slate-400">
                      {monthName} {invoice.periodYear} ·{" "}
                      {invoice.type === "PURCHASE" ? "Recibida" : "Emitida"}
                    </p>
                    {invoice.status === "REJECTED" && invoice.rejectionReason && (
                      <p className="text-[11px] text-red-500 mt-0.5">{invoice.rejectionReason}</p>
                    )}
                  </div>
                  <Badge variant={s.variant}>{s.label}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
