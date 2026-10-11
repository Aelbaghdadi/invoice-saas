import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import { ADMIN_CLIENT_TABS, parseClientTab } from "@/lib/clientSheet";
import { loadClientSheet } from "@/lib/clientSheetData";
import { ClientSheetShell } from "@/components/clients/ClientSheetShell";
import { ClientSummaryTab } from "@/components/clients/ClientSummaryTab";
import { ClientInvoicesTab, type InvoicesTabParams } from "@/components/clients/ClientInvoicesTab";
import { ClientPeriodsTab } from "@/components/clients/ClientPeriodsTab";
import { ClientExportsTab } from "@/components/clients/ClientExportsTab";
import { ClientActivityTab } from "@/components/clients/ClientActivityTab";
import { ClientSettingsTab } from "@/components/clients/ClientSettingsTab";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<InvoicesTabParams & { tab?: string }>;
};

/** Ficha completa de un cliente para el administrador. */
export default async function ClientDetailPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId;
  if (!firmId) notFound();

  const { id } = await params;
  const sp = await searchParams;
  const data = await loadClientSheet(id);
  // Un cliente de otra asesoria da el mismo 404 que uno que no existe.
  if (!data || data.client.advisoryFirmId !== firmId) notFound();

  const basePath = `/dashboard/admin/clients/${id}`;
  const tab = parseClientTab(sp.tab, ADMIN_CLIENT_TABS);

  return (
    <ClientSheetShell
      client={data.client}
      stats={data.stats}
      role="ADMIN"
      basePath={basePath}
      backHref="/dashboard/admin/clients"
      backLabel="Volver a clientes"
      tab={tab}
      tabs={ADMIN_CLIENT_TABS}
    >
      {tab === "resumen" && <ClientSummaryTab data={data} role="ADMIN" basePath={basePath} />}
      {tab === "facturas" && <ClientInvoicesTab clientId={id} role="ADMIN" basePath={basePath} params={sp} />}
      {tab === "periodos" && <ClientPeriodsTab clientId={id} periods={data.periods} role="ADMIN" basePath={basePath} />}
      {tab === "exportaciones" && <ClientExportsTab clientId={id} firmId={firmId} basePath={basePath} page={sp.page} />}
      {tab === "actividad" && <ClientActivityTab clientId={id} role="ADMIN" basePath={basePath} page={sp.page} />}
      {tab === "ajustes" && <ClientSettingsTab data={data} firmId={firmId} />}
    </ClientSheetShell>
  );
}
