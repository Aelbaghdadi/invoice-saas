import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { FileText, Upload } from "lucide-react";
import Link from "next/link";
import { ReuploadButton } from "./ReuploadButton";
import { formatDateEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { pageWindow, parsePage } from "@/lib/listing";
import { CLIENT_STATUS_BADGE } from "@/lib/invoiceStatuses";

const BASE_PATH = "/dashboard/client/invoices";

export default async function ClientInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // El listado de cliente esta scopeado a "su" Client.userId — admin no
  // tiene client propio. Le mandamos al listado global del admin.
  if (session.user.role === "ADMIN") redirect("/dashboard/admin/invoices");
  if (session.user.role !== "CLIENT") redirect("/login");

  const client = await prisma.client
    .findUnique({ where: { userId: session.user.id }, select: { id: true } })
    .catch(() => null);

  if (!client) redirect("/dashboard/client");

  const params = await searchParams;

  // Paginado en BD: un cliente que sube 50-100 facturas al mes pasa de mil
  // filas en un año, y antes venian todas de golpe.
  const where = { clientId: client.id };
  const total = await prisma.invoice.count({ where }).catch(() => 0);
  const window = pageWindow(parsePage(params.page), total);
  const invoices = await prisma.invoice
    .findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: window.skip,
      take: window.take,
    })
    .catch(() => []);

  return (
    <div>
      <PageHeader
        title="Mis Facturas"
        description={`${total} factura${total !== 1 ? "s" : ""} en total`}
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
                {/* "Subida el" y no "Fecha": es cuando se subio, no la fecha de la factura. */}
                {["Factura", "Periodo", "Tipo", "Estado", "Subida el"].map((h) => (
                  <th
                    key={h}
                    className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv) => {
                const s = CLIENT_STATUS_BADGE[inv.status];
                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                        <div className="min-w-0">
                          <span
                            className="block max-w-[200px] truncate text-[13px] font-medium text-slate-700"
                            title={inv.filename}
                          >
                            {inv.invoiceNumber ?? inv.filename}
                          </span>
                          {/* Con numero, el nombre del archivo sigue a la vista:
                              es lo que el cliente reconoce de lo que subio. */}
                          {inv.invoiceNumber && (
                            <span className="block max-w-[200px] truncate text-[11px] text-slate-400">
                              {inv.filename}
                            </span>
                          )}
                          {inv.status === "REJECTED" && inv.rejectionReason && (
                            <p className="text-[11px] text-red-500 mt-0.5">{inv.rejectionReason}</p>
                          )}
                          {inv.status === "REJECTED" && (
                            <ReuploadButton invoiceId={inv.id} />
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[13px] text-slate-500 whitespace-nowrap">
                      {periodLabel(inv.periodType, inv.periodMonth, inv.periodYear)}
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
                      {formatDateEs(inv.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination
          window={window}
          noun="facturas"
          hrefFor={(p) => (p > 1 ? `${BASE_PATH}?page=${p}` : BASE_PATH)}
        />
      </div>
    </div>
  );
}
