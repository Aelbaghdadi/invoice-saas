import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { PageHeader } from "@/components/ui/PageHeader";
import { GroupsManager } from "./GroupsManager";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const accessibleIds = await getAccessibleClientIds({ user: session.user });
  const clients = accessibleIds.length
    ? await prisma.client.findMany({
        where: { id: { in: accessibleIds }, isUnclassifiedBucket: false },
        orderBy: { name: "asc" },
        select: { id: true, name: true, cif: true },
      })
    : [];

  const groups = firmId
    ? await prisma.clientGroup.findMany({
        where: { advisoryFirmId: firmId },
        orderBy: { name: "asc" },
        include: { members: { select: { clientId: true } } },
      })
    : [];
  const groupData = groups.map((g) => ({ id: g.id, name: g.name, clientIds: g.members.map((m) => m.clientId) }));

  return (
    <div>
      <PageHeader
        title="Grupos de empresas"
        description="Agrupa las empresas de un mismo cliente (p. ej. sus 3 restaurantes) para subir todas sus facturas juntas y repartirlas por CIF automáticamente."
      />
      <GroupsManager clients={clients} groups={groupData} />
    </div>
  );
}
