import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { parseTaxId } from "@/lib/validators";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { formatDateTimeEs } from "@/lib/dates";
import {
  RECENTLY_ROUTED_DAYS,
  ROUTING_IN_PROGRESS,
  recentlyRoutedByClient,
  routingInboxWhere,
} from "@/lib/routingInbox";
import { AlertCircle, Building2, Inbox, Loader2, MousePointerClick } from "lucide-react";
import { ClasificarTable } from "./ClasificarTable";
import { RoutingErrorsList } from "./RoutingErrorsList";

// El conteo cambia conforme se clasifica; dinámico para no servir stale.
export const dynamic = "force-dynamic";

function normNif(v: string | null | undefined): string {
  return parseTaxId(v).clean.toUpperCase();
}
function normName(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export default async function ClasificarPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const accessibleIds = await getAccessibleClientIds({ user: session.user });

  // Todo lo de una subida «Clasificar entre varios» que aún está en el buzón,
  // y lo que ya salió de él estos días. Antes solo se veían las por asignar:
  // mientras se leían, o si fallaba la lectura, no salían en ningún sitio.
  const inbox = routingInboxWhere(accessibleIds);
  const [invoices, inProgress, inProgressCount, errors, recent] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...inbox, status: "PENDING_ROUTING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        filename: true,
        invoiceNumber: true,
        type: true,
        typeUnconfirmed: true,
        issuerCif: true,
        receiverCif: true,
        issuerName: true,
        receiverName: true,
        totalAmount: true,
        invoiceDate: true,
        routingReason: true,
        routingCandidateIds: true,
      },
    }),
    prisma.invoice.findMany({
      where: { ...inbox, status: { in: ROUTING_IN_PROGRESS } },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, filename: true, createdAt: true },
    }),
    prisma.invoice.count({ where: { ...inbox, status: { in: ROUTING_IN_PROGRESS } } }),
    prisma.invoice.findMany({
      where: { ...inbox, status: "OCR_ERROR" },
      orderBy: { createdAt: "asc" },
      select: { id: true, filename: true, lastOcrError: true, createdAt: true },
    }),
    recentlyRoutedByClient(accessibleIds),
  ]);

  const candidateIds = [...new Set(invoices.flatMap((i) => i.routingCandidateIds))];
  const clients = candidateIds.length
    ? await prisma.client.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  // Reglas aprendidas (proveedor→empresa) de la firma, para sugerir destino.
  const rules = firmId
    ? await prisma.providerRoutingRule.findMany({
        where: { advisoryFirmId: firmId, ambiguous: false },
        select: { providerNif: true, clientId: true },
      })
    : [];
  const clientByProviderNif = new Map(rules.map((r) => [r.providerNif, r.clientId]));

  const rows = invoices.map((inv) => {
    const candidates = inv.routingCandidateIds
      .filter((cid) => accessibleIds.includes(cid))
      .map((cid) => ({ id: cid, name: nameById.get(cid) ?? cid }));
    const candIds = new Set(candidates.map((c) => c.id));

    // Sugerencia: 1) regla aprendida por el CIF del proveedor (otra parte);
    //             2) coincidencia del nombre del lado del cliente con una empresa.
    let suggestedClientId: string | null = null;
    const otherNif = normNif(inv.type === "PURCHASE" ? inv.issuerCif : inv.receiverCif);
    const learned = otherNif ? clientByProviderNif.get(otherNif) : undefined;
    if (learned && candIds.has(learned)) {
      suggestedClientId = learned;
    } else {
      const sideName = normName(inv.type === "PURCHASE" ? inv.receiverName : inv.issuerName);
      if (sideName) {
        for (const c of candidates) {
          const cn = normName(c.name);
          if (cn && (sideName.includes(cn) || cn.includes(sideName))) {
            suggestedClientId = c.id;
            break;
          }
        }
      }
    }

    return {
      id: inv.id,
      filename: inv.filename,
      invoiceNumber: inv.invoiceNumber,
      type: inv.type as "PURCHASE" | "SALE",
      typeUnconfirmed: inv.typeUnconfirmed,
      issuerName: inv.issuerName,
      receiverName: inv.receiverName,
      issuerCif: inv.issuerCif,
      receiverCif: inv.receiverCif,
      total: inv.totalAmount != null ? Number(inv.totalAmount) : null,
      date: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
      reason: inv.routingReason,
      candidates,
      suggestedClientId,
    };
  });

  const recentTotal = recent.reduce((sum, r) => sum + r.count, 0);
  const summary = [
    { label: "Analizándose", value: inProgressCount, tone: "text-slate-700" },
    { label: "Con error de lectura", value: errors.length, tone: errors.length > 0 ? "text-red-600" : "text-slate-700" },
    { label: "Por clasificar", value: rows.length, tone: rows.length > 0 ? "text-amber-600" : "text-slate-700" },
    { label: `Repartidas (${RECENTLY_ROUTED_DAYS} días)`, value: recentTotal, tone: "text-emerald-600" },
  ];
  const nothing = rows.length === 0 && errors.length === 0 && inProgressCount === 0 && recentTotal === 0;

  return (
    <div>
      <PageHeader
        title="Reparto de facturas"
        description="Las facturas subidas con «Clasificar entre varios» se asignan solas a su empresa por el CIF. Aquí ves cómo se han repartido y lo que necesita tu ayuda."
      />
      {nothing ? (
        <EmptyState
          icon={Inbox}
          title="Nada que repartir"
          description="Cuando subas facturas de varias empresas juntas con «Clasificar entre varios», verás aquí cómo se reparten."
        />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {summary.map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className={`text-[22px] font-bold tabular-nums ${s.tone}`}>{s.value}</p>
                <p className="text-[12px] text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>

          {rows.length > 0 && (
            <section>
              <SectionTitle icon={MousePointerClick} title="Por clasificar" hint="El CIF no bastó para saber de qué empresa son: elige tú." />
              <ClasificarTable rows={rows} />
            </section>
          )}

          {errors.length > 0 && (
            <section>
              <SectionTitle icon={AlertCircle} title="Con error de lectura" hint="No se pudieron leer. Reprocésalas; si vuelven a fallar, revisa que el fichero se vea bien." />
              <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
                <RoutingErrorsList
                  rows={errors.map((e) => ({ id: e.id, filename: e.filename, lastOcrError: e.lastOcrError, uploadedAt: e.createdAt.toISOString() }))}
                />
              </div>
            </section>
          )}

          {inProgressCount > 0 && (
            <section>
              {/* Se refresca sola mientras quede alguna leyéndose. */}
              <AutoRefresh signature={`${inProgressCount}-${rows.length}-${errors.length}-${recentTotal}`} />
              <SectionTitle icon={Loader2} title="Analizándose" hint="Se están leyendo; cuando terminen, cada una irá a su empresa o a «Por clasificar»." />
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
                {inProgress.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <span className="truncate text-slate-700" title={inv.filename}>{inv.filename}</span>
                    <span className="flex-shrink-0 text-[11px] text-slate-400">subida el {formatDateTimeEs(inv.createdAt)}</span>
                  </li>
                ))}
                {inProgressCount > inProgress.length && (
                  <li className="px-4 py-2.5 text-[12px] text-slate-400">y {inProgressCount - inProgress.length} más…</li>
                )}
              </ul>
            </section>
          )}

          {recent.length > 0 && (
            <section>
              <SectionTitle icon={Building2} title={`Repartidas en los últimos ${RECENTLY_ROUTED_DAYS} días`} hint="Ya están en su empresa, listas para revisar como cualquier otra." />
              <div className="flex flex-wrap gap-2">
                {recent.map((r) => (
                  <Link
                    key={r.clientId}
                    href={`/dashboard/worker/invoices?clientId=${r.clientId}&bucket=all`}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                  >
                    <span className="font-medium">{r.name}</span>
                    <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 tabular-nums">{r.count}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint: string }) {
  return (
    <div className="mb-2">
      <h2 className="flex items-center gap-2 text-[14px] font-semibold text-slate-800">
        <Icon className="h-4 w-4 text-slate-400" />
        {title}
      </h2>
      <p className="mt-0.5 text-[12px] text-slate-500">{hint}</p>
    </div>
  );
}
