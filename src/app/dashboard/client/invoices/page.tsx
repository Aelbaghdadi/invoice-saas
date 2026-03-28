import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { FileText, Upload } from "lucide-react";
import Link from "next/link";

const STATUS_BADGE: Record<string, { label: string; variant: any }> = {
  UPLOADED:  { label: "Subida",       variant: "blue" },
  ANALYZING: { label: "En análisis",  variant: "yellow" },
  VALIDATED: { label: "Validada",     variant: "green" },
  EXPORTED:  { label: "Exportada",    variant: "slate" },
};

export default async function ClientInvoicesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "CLIENT") redirect("/login");

  const client = await prisma.client
    .findUnique({
      where: { userId: session.user.id },
      include: {
        invoices: { orderBy: { createdAt: "desc" } },
      },
    })
    .catch(() => null);

  if (!client) redirect("/dashboard/client");

  const invoices = client.invoices;

  return (
    <div>
      <PageHeader
        title="Mis Facturas"
        description={`${invoices.length} factura${invoices.length !== 1 ? "s" : ""} en total`}
        action={
          <Link
            href="/dashboard/client/upload"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700"
          >
            <Upload className="h-4 w-4" />
            Subir facturas
          </Link>
        }
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {invoices.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Sin facturas todavía"
            description="Sube tus primeras facturas para que sean procesadas."
            action={
              <Link
                href="/dashboard/client/upload"
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-blue-700"
              >
                <Upload className="h-4 w-4" />
                Subir facturas
              </Link>
            }
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                {["Archivo", "Período", "Tipo", "Estado", "Fecha"].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv) => {
                const s = STATUS_BADGE[inv.status] ?? STATUS_BADGE.UPLOADED;
                const monthName = new Date(0, inv.periodMonth - 1).toLocaleString(
                  "es",
                  { month: "long" }
                );
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <span className="max-w-[200px] truncate text-[13px] font-medium text-slate-700">
                          {inv.filename}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[13px] capitalize text-slate-500">
                      {monthName} {inv.periodYear}
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>
                        {inv.type === "PURCHASE" ? "Recibida" : "Emitida"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-400 whitespace-nowrap">
                      {inv.createdAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
