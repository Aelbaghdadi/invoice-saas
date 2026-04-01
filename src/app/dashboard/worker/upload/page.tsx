import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { WorkerUploadForm } from "./WorkerUploadForm";

export default async function WorkerUploadPage() {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    redirect("/login");
  }

  // Get assigned clients (workers see assigned, admins see all)
  let clients;
  if (session.user.role === "ADMIN") {
    clients = await prisma.client.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, cif: true },
    });
  } else {
    const assignments = await prisma.workerClientAssignment.findMany({
      where: { workerId: session.user.id },
      include: { client: { select: { id: true, name: true, cif: true } } },
    });
    clients = assignments.map((a) => a.client);
  }

  if (clients.length === 0) {
    return (
      <div>
        <PageHeader
          title="Subir facturas"
          description="Sube facturas en nombre de tus clientes asignados."
        />
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-400">
          <p className="text-[14px] font-medium">No tienes clientes asignados</p>
          <p className="text-[13px]">Contacta con tu administrador.</p>
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
        <WorkerUploadForm clients={clients} />
      </div>
    </div>
  );
}
