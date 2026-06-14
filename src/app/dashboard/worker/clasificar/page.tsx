import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Inbox } from "lucide-react";
import { ClasificarTable } from "./ClasificarTable";

// El conteo cambia conforme se clasifica; dinámico para no servir stale.
export const dynamic = "force-dynamic";

export default async function ClasificarPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");

  const accessibleIds = await getAccessibleClientIds({ user: session.user });

  const invoices = await prisma.invoice.findMany({
    where: {
      status: "PENDING_ROUTING",
      routingCandidateIds: { hasSome: accessibleIds },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      filename: true,
      type: true,
      issuerCif: true,
      receiverCif: true,
      totalAmount: true,
      invoiceDate: true,
      routingReason: true,
      routingCandidateIds: true,
    },
  });

  const candidateIds = [...new Set(invoices.flatMap((i) => i.routingCandidateIds))];
  const clients = candidateIds.length
    ? await prisma.client.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(clients.map((c) => [c.id, c.name]));

  const rows = invoices.map((inv) => ({
    id: inv.id,
    filename: inv.filename,
    type: inv.type as "PURCHASE" | "SALE",
    issuerCif: inv.issuerCif,
    receiverCif: inv.receiverCif,
    total: inv.totalAmount != null ? Number(inv.totalAmount) : null,
    date: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
    reason: inv.routingReason,
    // Solo candidatos accesibles para este gestor.
    candidates: inv.routingCandidateIds
      .filter((cid) => accessibleIds.includes(cid))
      .map((cid) => ({ id: cid, name: nameById.get(cid) ?? cid })),
  }));

  return (
    <div>
      <PageHeader
        title="Por clasificar"
        description="Facturas subidas en modo clasificar cuyo CIF no se pudo asignar automáticamente. Elige la empresa y confirma."
      />
      {rows.length === 0 ? (
        <EmptyState icon={Inbox} title="Nada por clasificar" description="Todas las facturas subidas se rutearon automáticamente a su empresa." />
      ) : (
        <ClasificarTable rows={rows} />
      )}
    </div>
  );
}
