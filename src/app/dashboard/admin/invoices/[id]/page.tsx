import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { ChevronLeft, Building2, Calendar, Hash, Euro, Percent, User } from "lucide-react";
import Link from "next/link";
import { AdminInvoiceViewer } from "./AdminInvoiceViewer";
import { ReprocesarButton } from "./ReprocesarButton";

const STATUS_LABELS: Record<string, string> = {
  UPLOADED: "Subida",
  ANALYZING: "En analisis",
  ANALYZED: "Analizada",
  OCR_ERROR: "Error OCR",
  VALIDATED: "Validada",
  REJECTED: "Rechazada",
  EXPORTED: "Exportada",
  PENDING_REVIEW: "Pte. revisión",
  NEEDS_ATTENTION: "Con incidencias",
};

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",      variant: "blue" },
  ANALYZING: { label: "En análisis", variant: "yellow" },
  ANALYZED:  { label: "Analizada",   variant: "yellow" },
  OCR_ERROR: { label: "Error OCR",   variant: "red" },
  VALIDATED: { label: "Validada",    variant: "green" },
  REJECTED:  { label: "Rechazada",   variant: "red" },
  EXPORTED:        { label: "Exportada",      variant: "slate" },
  PENDING_REVIEW:  { label: "Pte. revisión",  variant: "blue" },
  NEEDS_ATTENTION: { label: "Con incidencias", variant: "yellow" },
};

function Field({ label, value, icon: Icon }: { label: string; value?: string | null; icon?: any }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </p>
      <p className="mt-1 text-[14px] font-medium text-slate-800">
        {value ?? <span className="font-normal italic text-slate-300">—</span>}
      </p>
    </div>
  );
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      auditLogs: { include: { user: true }, orderBy: { createdAt: "desc" } },
      statusHistory: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!invoice) notFound();
  if (invoice.client.advisoryFirmId !== firmId) notFound();

  const s = STATUS_BADGE[invoice.status] ?? STATUS_BADGE.UPLOADED;

  return (
    <div>
      <Link href="/dashboard/admin/invoices" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Volver a facturas
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-[18px] font-semibold text-slate-900">{invoice.filename}</h1>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge variant={s.variant}>{s.label}</Badge>
            <Badge variant={invoice.type === "PURCHASE" ? "blue" : "purple"}>
              {invoice.type === "PURCHASE" ? "Recibida" : "Emitida"}
            </Badge>
          </div>
        </div>
      </div>

      {invoice.status === "OCR_ERROR" && invoice.lastOcrError && (
        <div className="mb-6 rounded-xl bg-red-50 border border-red-200 p-4">
          <p className="text-[13px] font-medium text-red-700">Error de procesamiento OCR</p>
          <p className="text-[12px] text-red-500 mt-1">{invoice.lastOcrError}</p>
          <div className="mt-3">
            <ReprocesarButton invoiceId={invoice.id} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-5">
        {/* File viewer + audit log */}
        <div className="col-span-2 flex flex-col gap-5">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-[#1e1e2e] shadow-sm" style={{ height: 600 }}>
            <AdminInvoiceViewer
              invoiceId={invoice.id}
              fileType={invoice.fileType}
              filename={invoice.filename}
            />
          </div>

          {/* Status history timeline */}
          {invoice.statusHistory.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-5 py-4">
                <h2 className="text-[14px] font-semibold text-slate-800">Historial de estados</h2>
              </div>
              <div className="px-5 py-4">
                <div className="relative space-y-0">
                  {invoice.statusHistory.map((entry, i) => (
                    <div key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">
                      {/* Vertical line */}
                      {i < invoice.statusHistory.length - 1 && (
                        <div className="absolute left-[7px] top-4 bottom-0 w-px bg-slate-200" />
                      )}
                      {/* Dot */}
                      <div className="relative z-10 mt-1 h-[15px] w-[15px] flex-shrink-0 rounded-full border-2 border-slate-300 bg-white" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-slate-700">
                          {entry.fromStatus
                            ? `${STATUS_LABELS[entry.fromStatus] ?? entry.fromStatus} → ${STATUS_LABELS[entry.toStatus] ?? entry.toStatus}`
                            : STATUS_LABELS[entry.toStatus] ?? entry.toStatus}
                        </p>
                        {entry.reason && (
                          <p className="mt-0.5 text-[12px] text-slate-500">{entry.reason}</p>
                        )}
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          {entry.createdAt.toLocaleDateString("es-ES")}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Audit log */}
          {invoice.auditLogs.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-5 py-4">
                <h2 className="text-[14px] font-semibold text-slate-800">Registro de auditoría</h2>
              </div>
              <ul className="divide-y divide-slate-50">
                {invoice.auditLogs.map((log) => (
                  <li key={log.id} className="flex items-start gap-3 px-5 py-3">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-100">
                      <User className="h-3.5 w-3.5 text-slate-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-slate-700">
                        <span className="font-semibold">{log.user.name}</span> modificó{" "}
                        <span className="font-mono text-[12px] text-slate-500">{log.field}</span>
                      </p>
                      <p className="text-[12px] text-slate-400">
                        {log.oldValue ?? "—"} → {log.newValue ?? "—"}
                      </p>
                    </div>
                    <p className="flex-shrink-0 text-[11px] text-slate-400">
                      {log.createdAt.toISOString().slice(0, 10)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Extracted data */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Datos de factura</h2>
            <div className="space-y-4">
              <Field label="Nº Factura" value={invoice.invoiceNumber} icon={Hash} />
              <Field
                label="Fecha factura"
                value={invoice.invoiceDate ? invoice.invoiceDate.toISOString().slice(0, 10) : null}
                icon={Calendar}
              />
              <Field label="Período" value={`${new Date(0, invoice.periodMonth - 1).toLocaleString("es", { month: "long" })} ${invoice.periodYear}`} icon={Calendar} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Partes</h2>
            <div className="space-y-4">
              <Field label="Emisor" value={invoice.issuerName} icon={Building2} />
              <Field label="CIF Emisor" value={invoice.issuerCif} icon={Hash} />
              <Field label="Receptor" value={invoice.receiverName} icon={Building2} />
              <Field label="CIF Receptor" value={invoice.receiverCif} icon={Hash} />
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-[14px] font-semibold text-slate-800">Importes</h2>
            <div className="space-y-4">
              <Field label="Base imponible" value={invoice.taxBase ? `€${invoice.taxBase}` : null} icon={Euro} />
              <Field label="% IVA" value={invoice.vatRate ? `${invoice.vatRate}%` : null} icon={Percent} />
              <Field label="Cuota IVA" value={invoice.vatAmount ? `€${invoice.vatAmount}` : null} icon={Euro} />
              <Field label="% IRPF" value={invoice.irpfRate ? `${invoice.irpfRate}%` : null} icon={Percent} />
              <Field label="Total" value={invoice.totalAmount ? `€${invoice.totalAmount}` : null} icon={Euro} />
            </div>

            {invoice.isValid !== null && (
              <div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium ${invoice.isValid ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                <div className={`h-2 w-2 rounded-full ${invoice.isValid ? "bg-green-500" : "bg-red-500"}`} />
                {invoice.isValid ? "Validación matemática correcta" : "Validación matemática incorrecta"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
