import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { UploadForm } from "./UploadForm";

export default async function ClientUploadPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // ADMIN no tiene "su" cliente — le mandamos al upload del gestor que ya
  // permite elegir cliente de la firma.
  if (session.user.role === "ADMIN") redirect("/dashboard/worker/upload");
  if (session.user.role !== "CLIENT") redirect("/login");

  const client = await prisma.client
    .findUnique({ where: { userId: session.user.id } })
    .catch(() => null);

  if (!client) redirect("/dashboard/client");

  return (
    <div>
      <PageHeader
        title="Subir facturas"
        description="Carga tus facturas en PDF o XML para que sean procesadas automáticamente."
      />
      <div className="max-w-2xl">
        <UploadForm />
      </div>
    </div>
  );
}
