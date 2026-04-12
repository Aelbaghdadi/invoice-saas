import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClipboardList, ArrowRight } from "lucide-react";
import { AuditFilters } from "./AuditFilters";

const FIELD_LABELS: Record<string, string> = {
  status: "Estado", issuerName: "Emisor", issuerCif: "CIF emisor",
  receiverName: "Receptor", receiverCif: "CIF receptor",
  invoiceNumber: "Nº factura", invoiceDate: "Fecha",
  taxBase: "Base imponible", vatRate: "% IVA", vatAmount: "Cuota IVA",
  irpfRate: "% IRPF", irpfAmount: "Cuota IRPF", totalAmount: "Total",
  export: "Exportación", duplicate_warning: "Duplicado",
};

const VALUE_LABELS: Record<string, string> = {
  UPLOADED: "Subida", ANALYZING: "En análisis", ANALYZED: "Analizada",
  OCR_ERROR: "Error OCR", VALIDATED: "Validada", REJECTED: "Rechazada",
  EXPORTED: "Exportada", PENDING_REVIEW: "Pte. revisión",
  NEEDS_ATTENTION: "Con incidencias", PURCHASE: "Recibida", SALE: "Emitida",
};

function fmtVal(v: string | null): string {
  if (!v) return "—";
  return VALUE_LABELS[v] ?? v;
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function avatarColor(name: string) {
  const colors = [
    "bg-blue-100 text-blue-700",
    "bg-green-100 text-green-700",
    "bg-purple-100 text-purple-700",
    "bg-orange-100 text-orange-700",
    "bg-red-100 text-red-700",
    "bg-teal-100 text-teal-700",
  ];
  let hash = 0;
  for (const c of name) hash += c.charCodeAt(0);
  return colors[hash % colors.length];
}

type Props = {
  searchParams: Promise<Record<string, string | undefined>>;
};

export default async function AuditLogPage({ searchParams }: Props) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const params = await searchParams;
  const q = params.q ?? "";
  const userId = params.user ?? "";
  const field = params.field ?? "";
  const dateFrom = params.from ?? "";
  const dateTo = params.to ?? "";

  // Build where clause
  const where: Record<string, unknown> = {
    invoice: { client: { advisoryFirmId: firmId } },
  };

  if (userId) where.userId = userId;
  if (field) where.field = field;

  if (dateFrom || dateTo) {
    where.createdAt = {
      ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
      ...(dateTo ? { lte: new Date(dateTo + "T23:59:59.999Z") } : {}),
    };
  }

  if (q) {
    where.OR = [
      { invoice: { filename: { contains: q, mode: "insensitive" } } },
      { invoice: { client: { name: { contains: q, mode: "insensitive" } } } },
      { field: { contains: q, mode: "insensitive" } },
      { newValue: { contains: q, mode: "insensitive" } },
    ];
  }

  const [logs, allUsers, distinctFields] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: true,
        invoice: { include: { client: true } },
      },
    }).catch(() => []),
    prisma.user.findMany({
      where: { role: { in: ["ADMIN", "WORKER"] }, advisoryFirmId: firmId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }).catch(() => []),
    prisma.auditLog.findMany({
      where: { invoice: { client: { advisoryFirmId: firmId } } },
      distinct: ["field"],
      select: { field: true },
      orderBy: { field: "asc" },
    }).catch(() => []),
  ]);

  const fields = distinctFields.map((d) => d.field);

  return (
    <div>
      <PageHeader
        title="Registro de auditoría"
        description="Historial completo de cambios realizados en las facturas"
      />

      <AuditFilters users={allUsers} fields={fields} />

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {logs.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Sin registros"
            description={q || userId || field || dateFrom || dateTo
              ? "No se encontraron registros con los filtros aplicados."
              : "Los cambios en las facturas se registrarán aquí automáticamente."}
          />
        ) : (
          <div className="overflow-x-auto">
            <div className="px-5 py-3 border-b border-slate-100">
              <p className="text-[12px] text-slate-400">{logs.length} registro{logs.length !== 1 ? "s" : ""}</p>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  {["Fecha", "Usuario", "Factura", "Cliente", "Campo", "Cambio"].map((h) => (
                    <th key={h} className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-5 py-3 text-[12px] text-slate-500 whitespace-nowrap">
                      {log.createdAt.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })}
                      {" "}
                      <span className="text-slate-400">{log.createdAt.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${avatarColor(log.user.name ?? "U")}`}>
                          {initials(log.user.name ?? "U")}
                        </div>
                        <span className="text-[13px] font-medium text-slate-700">{log.user.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 max-w-[160px]">
                      <p className="truncate text-[13px] text-slate-600">{log.invoice.filename}</p>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-slate-500">{log.invoice.client.name}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {FIELD_LABELS[log.field] ?? log.field}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-500 line-through">{fmtVal(log.oldValue)}</span>
                        <ArrowRight className="h-3 w-3 flex-shrink-0 text-slate-300" />
                        <span className="rounded bg-green-50 px-1.5 py-0.5 font-medium text-green-700">{fmtVal(log.newValue)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
