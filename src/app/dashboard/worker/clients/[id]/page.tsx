import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { canAccessClient } from "@/lib/accessibleClients";
import { parseClientTab, WORKER_CLIENT_TABS } from "@/lib/clientSheet";
import { loadClientSheet } from "@/lib/clientSheetData";
import { ClientSheetShell } from "@/components/clients/ClientSheetShell";
import { ClientSummaryTab } from "@/components/clients/ClientSummaryTab";
import { ClientInvoicesTab, type InvoicesTabParams } from "@/components/clients/ClientInvoicesTab";
import { ClientPeriodsTab } from "@/components/clients/ClientPeriodsTab";
import { ClientActivityTab } from "@/components/clients/ClientActivityTab";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<InvoicesTabParams & { tab?: string }>;
};

/** Ficha de un cliente para el gestor: lo mismo que la del administrador
 *  menos exportar y editar. El administrador va a la suya. */
export default async function WorkerClientDetailPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");
  const { id } = await params;
  if (session.user.role === "ADMIN") redirect(`/dashboard/admin/clients/${id}`);

  // Solo los clientes asignados al gestor.
  if (!(await canAccessClient(session, id))) notFound();
  const sp = await searchParams;
  const data = await loadClientSheet(id);
  if (!data) notFound();

  const basePath = `/dashboard/worker/clients/${id}`;
  const tab = parseClientTab(sp.tab, WORKER_CLIENT_TABS);

  return (
    <ClientSheetShell
      client={data.client}
      stats={data.stats}
      role="WORKER"
      basePath={basePath}
      backHref="/dashboard/worker/clients"
      backLabel="Volver a mis clientes"
      tab={tab}
      tabs={WORKER_CLIENT_TABS}
    >
      {tab === "resumen" && <ClientSummaryTab data={data} role="WORKER" basePath={basePath} />}
      {tab === "facturas" && <ClientInvoicesTab clientId={id} role="WORKER" basePath={basePath} params={sp} />}
      {tab === "periodos" && <ClientPeriodsTab clientId={id} periods={data.periods} role="WORKER" basePath={basePath} />}
      {tab === "actividad" && <ClientActivityTab clientId={id} role="WORKER" basePath={basePath} page={sp.page} />}
    </ClientSheetShell>
  );
}
