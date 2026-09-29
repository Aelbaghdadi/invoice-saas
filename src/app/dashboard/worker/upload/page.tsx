import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { adminUploadClientsWhere } from "@/lib/uploadClients";
import { PageHeader } from "@/components/ui/PageHeader";
import { WorkerUploadForm } from "./WorkerUploadForm";

export default async function WorkerUploadPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    redirect("/login");
  }

  // Gestor: sus clientes asignados. Admin: los de su asesoría, sin el cliente
  // técnico "Sin clasificar" (buzón de auto-ruteo).
  let clients;
  if (session.user.role === "ADMIN") {
    const where = adminUploadClientsWhere(session.user.advisoryFirmId);
    clients = where
      ? await prisma.client.findMany({
          where,
          orderBy: { name: "asc" },
          select: { id: true, name: true, cif: true },
        })
      : [];
  } else {
    const assignments = await prisma.workerClientAssignment.findMany({
      where: { workerId: session.user.id },
      include: { client: { select: { id: true, name: true, cif: true } } },
    });
    clients = assignments.map((a) => a.client);
  }

  // Grupos de empresas de la firma (para el modo "clasificar entre varios").
  const firmId = session.user.advisoryFirmId ?? undefined;
  const groupsRaw = firmId
    ? await prisma.clientGroup.findMany({
        where: { advisoryFirmId: firmId },
        orderBy: { name: "asc" },
        include: { members: { select: { clientId: true } } },
      })
    : [];
  const groups = groupsRaw.map((g) => ({ id: g.id, name: g.name, clientIds: g.members.map((m) => m.clientId) }));

  if (clients.length === 0) {
    const isAdmin = session.user.role === "ADMIN";
    return (
      <div>
        <PageHeader
          title="Subir facturas"
          description={
            isAdmin
              ? "Sube facturas en nombre de un cliente."
              : "Sube facturas en nombre de tus clientes asignados."
          }
        />
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-400">
          {isAdmin ? (
            <>
              <p className="text-[14px] font-medium">Tu asesoría aún no tiene clientes</p>
              <Link
                href="/dashboard/admin/clients"
                className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
              >
                Ir a Clientes
              </Link>
            </>
          ) : (
            <>
              <p className="text-[14px] font-medium">No tienes clientes asignados</p>
              <p className="text-[13px]">Contacta con tu administrador.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Subir facturas"
        description="Sube facturas en nombre de un cliente."
      />
      <div className="max-w-2xl">
        <WorkerUploadForm clients={clients} groups={groups} />
      </div>
    </div>
  );
}
