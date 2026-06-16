import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { parseTaxId } from "@/lib/validators";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Inbox } from "lucide-react";
import { ClasificarTable } from "./ClasificarTable";

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
      issuerName: true,
      receiverName: true,
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
      type: inv.type as "PURCHASE" | "SALE",
      issuerCif: inv.issuerCif,
      receiverCif: inv.receiverCif,
      total: inv.totalAmount != null ? Number(inv.totalAmount) : null,
      date: inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : null,
      reason: inv.routingReason,
      candidates,
      suggestedClientId,
    };
  });

  return (
    <div>
      <PageHeader
        title="Por clasificar"
        description="Facturas subidas en modo clasificar cuyo CIF no se pudo asignar automáticamente. Pulsa 'Clasificar de una en una' para verlas e ir asignándolas con el teclado."
      />
      {rows.length === 0 ? (
        <EmptyState icon={Inbox} title="Nada por clasificar" description="Todas las facturas subidas se rutearon automáticamente a su empresa." />
      ) : (
        <ClasificarTable rows={rows} />
      )}
    </div>
  );
}
