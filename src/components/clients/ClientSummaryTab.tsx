import Link from "next/link";
import { ArrowRight, Boxes, Building2, FileText, Lock, Mail, Phone, Route, StickyNote, User } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/Badge";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { formatDateEs, formatDateTimeEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { auditActor, auditFieldLabelInline, formatAuditValue } from "@/lib/invoiceStatuses";
import { clientSheetHref, type PeriodRow } from "@/lib/clientSheet";
import type { ClientSheetData } from "@/lib/clientSheetData";
import { invoiceHref, type ClientSheetRole } from "./links";

const RECENT_INVOICES = 8;
const RECENT_ACTIVITY = 6;
const RECENT_PERIODS = 6;

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <h2 className="text-[14px] font-semibold text-slate-800">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function SeeAll({ href }: { href: string }) {
  return (
    <Link href={href} className="flex items-center gap-1 text-[12px] font-medium text-blue-600 hover:text-blue-700">
      Ver todo
      <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

function Row({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-300" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
        <div className="text-[13px] text-slate-700">{children}</div>
      </div>
    </div>
  );
}

const none = <span className="italic text-slate-300">—</span>;

/** Resumen: datos, gestores, grupos, los ultimos periodos, facturas y cambios. */
export async function ClientSummaryTab({ data, role, basePath }: { data: ClientSheetData; role: ClientSheetRole; basePath: string }) {
  const { client, periods, workers, groups, learnedProviders } = data;
  const [recentInvoices, recentLogs] = await Promise.all([
    prisma.invoice.findMany({
      where: { clientId: client.id, status: { notIn: ["SPLIT_SOURCE"] } },
      orderBy: { createdAt: "desc" },
      take: RECENT_INVOICES,
      select: {
        id: true, filename: true, invoiceNumber: true, type: true, status: true, issuerName: true, receiverName: true,
        periodType: true, periodMonth: true, periodYear: true, createdAt: true, exportBatchId: true,
        exportBatchItems: { take: 1, select: { id: true } },
      },
    }),
    prisma.auditLog.findMany({
      where: { invoice: { clientId: client.id } },
      orderBy: { createdAt: "desc" },
      take: RECENT_ACTIVITY,
      include: { user: { select: { name: true } }, invoice: { select: { id: true, invoiceNumber: true, filename: true } } },
    }),
  ]);

  const recentPeriods: PeriodRow[] = periods.slice(0, RECENT_PERIODS);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      {/* Columna izquierda: datos */}
      <div className="space-y-5">
        <Card title="Datos del cliente">
          <div className="space-y-4 p-5">
            <Row icon={User} label="Persona de contacto">{client.contactName || none}</Row>
            <Row icon={Phone} label="Teléfono">
              {client.phone ? <a href={`tel:${client.phone.replace(/\s+/g, "")}`} className="hover:text-blue-700">{client.phone}</a> : none}
            </Row>
            <Row icon={Mail} label="Acceso al portal">
              {client.email ?? <span className="italic text-slate-400">Sin acceso al portal</span>}
            </Row>
            <Row icon={Building2} label="Software contable">{client.accountingProgram || none}</Row>
            <Row icon={Route} label="Ruteo automático">
              {learnedProviders > 0
                ? `${learnedProviders} proveedor${learnedProviders !== 1 ? "es" : ""} aprendido${learnedProviders !== 1 ? "s" : ""}`
                : <span className="text-slate-400">Aún sin proveedores aprendidos</span>}
            </Row>
            <Row icon={StickyNote} label="Notas internas">
              {client.notes ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{client.notes}</p> : none}
            </Row>
            <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">Cliente desde el {formatDateEs(client.createdAt)}</p>
          </div>
        </Card>

        <Card
          title="Gestores asignados"
          action={role === "ADMIN" ? (
            <Link href={clientSheetHref(basePath, { tab: "ajustes" })} className="text-[12px] font-medium text-blue-600 hover:text-blue-700">Cambiar</Link>
          ) : undefined}
        >
          <div className="p-5">
            {workers.length === 0 ? (
              <p className="text-[12px] text-slate-400">Sin gestores asignados.</p>
            ) : (
              <ul className="space-y-2">
                {workers.map((w) => (
                  <li key={w.id} className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-700">
                      {w.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                    </div>
                    {role === "ADMIN" ? (
                      <Link href={`/dashboard/admin/workers/${w.id}`} className="text-[13px] text-slate-700 hover:text-blue-700">{w.name}</Link>
                    ) : (
                      <span className="text-[13px] text-slate-600">{w.name}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Grupos de empresas">
          <div className="p-5">
            {groups.length === 0 ? (
              <p className="text-[12px] text-slate-400">No está en ningún grupo.</p>
            ) : (
              <ul className="space-y-2">
                {groups.map((g) => (
                  <li key={g.id}>
                    <Link href="/dashboard/worker/groups" className="flex items-center gap-2 text-[13px] text-slate-700 hover:text-blue-700">
                      <Boxes className="h-4 w-4 text-slate-300" />
                      {g.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Columna derecha: actividad */}
      <div className="space-y-5 xl:col-span-2">
        <Card title="Últimos periodos" action={<SeeAll href={clientSheetHref(basePath, { tab: "periodos" })} />}>
          {recentPeriods.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-400">Sin facturas todavía.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5 text-left">Periodo</th>
                  <th className="px-5 py-2.5 text-right">Facturas</th>
                  <th className="px-5 py-2.5 text-right">Pendientes</th>
                  <th className="px-5 py-2.5 text-right">Exportadas</th>
                  <th className="px-5 py-2.5 text-left">Cierre</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {recentPeriods.map((p) => (
                  <tr key={`${p.periodType}-${p.periodYear}-${p.periodMonth}`} className="hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-medium text-slate-800">
                      <Link
                        href={clientSheetHref(basePath, {
                          tab: "facturas",
                          year: p.periodYear,
                          ...(p.periodType === "QUARTERLY" ? { quarter: Math.ceil(p.periodMonth / 3) } : { month: p.periodMonth }),
                        })}
                        className="hover:text-blue-700"
                      >
                        {p.label}
                      </Link>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">{p.total}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {p.pending > 0 ? <span className="font-semibold text-amber-700">{p.pending}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">{p.exported > 0 ? `${p.exported} / ${p.total}` : <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-2.5">
                      {p.closed ? (
                        <span className="inline-flex items-center gap-1 text-[12px] text-slate-600"><Lock className="h-3 w-3 text-slate-400" />Cerrado</span>
                      ) : (
                        <span className="text-[12px] text-slate-400">Abierto</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Últimas facturas" action={<SeeAll href={clientSheetHref(basePath, { tab: "facturas" })} />}>
          {recentInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <FileText className="mb-3 h-8 w-8 text-slate-200" />
              <p className="text-[13px] text-slate-400">Sin facturas subidas.</p>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-5 py-2.5 text-left">Factura</th>
                  <th className="hidden px-5 py-2.5 text-left lg:table-cell">Periodo</th>
                  <th className="px-5 py-2.5 text-left">Tipo</th>
                  <th className="px-5 py-2.5 text-left">Estado</th>
                  <th className="hidden px-5 py-2.5 text-left lg:table-cell">Subida</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {recentInvoices.map((inv) => {
                  const exported = inv.exportBatchItems.length > 0;
                  const counterpart = inv.type === "SALE" ? inv.receiverName : inv.issuerName;
                  return (
                    <tr key={inv.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-2.5">
                        <p className="max-w-[220px] truncate font-semibold text-slate-800" title={inv.filename}>{inv.invoiceNumber ?? inv.filename}</p>
                        {counterpart && <p className="max-w-[220px] truncate text-[11px] text-slate-400">{counterpart}</p>}
                      </td>
                      <td className="hidden px-5 py-2.5 text-slate-500 lg:table-cell">{periodLabel(inv.periodType, inv.periodMonth, inv.periodYear)}</td>
                      <td className="px-5 py-2.5">
                        <Badge variant={inv.type === "PURCHASE" ? "blue" : "purple"}>{inv.type === "PURCHASE" ? "Recibida" : "Emitida"}</Badge>
                      </td>
                      <td className="px-5 py-2.5">
                        <InvoiceStatusBadge status={inv.status} exported={exported} pendingReexport={exported && inv.exportBatchId == null} />
                      </td>
                      <td className="hidden px-5 py-2.5 text-slate-500 lg:table-cell">{formatDateEs(inv.createdAt)}</td>
                      <td className="px-5 py-2.5 text-right">
                        <Link href={invoiceHref(role, inv.id, basePath)} className="font-medium text-blue-600 hover:text-blue-700">Ver</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Actividad reciente" action={<SeeAll href={clientSheetHref(basePath, { tab: "actividad" })} />}>
          {recentLogs.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-slate-400">Sin actividad registrada.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {recentLogs.map((log) => (
                <li key={log.id} className="px-5 py-3">
                  <p className="text-[13px] text-slate-800">
                    <span className="font-semibold">{auditActor(log.field, log.user.name, log.oldValue, log.newValue)}</span>
                    {" "}cambió <span className="font-semibold text-slate-600">{auditFieldLabelInline(log.field)}</span> en{" "}
                    <Link href={invoiceHref(role, log.invoice.id, basePath)} className="font-medium hover:text-blue-700">
                      {log.invoice.invoiceNumber ?? log.invoice.filename}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-[12px] text-slate-500">
                    {formatAuditValue(log.oldValue, log.field)}
                    <span className="mx-1 text-slate-300">→</span>
                    <span className="font-medium text-slate-600">{formatAuditValue(log.newValue, log.field)}</span>
                    <span className="mx-1.5 text-slate-300">·</span>
                    {formatDateTimeEs(log.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
