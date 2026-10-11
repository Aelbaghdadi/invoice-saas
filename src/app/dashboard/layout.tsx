import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { supportActorFor } from "@/lib/supportAccess";
import { Role } from "@prisma/client";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const role = session.user.role as Role;

  // Logo + nombre de la asesoría para la marca de la barra lateral (arriba a la
  // izquierda). null -> se usa la marca por defecto (Faktury).
  const [firm, supportActor] = await Promise.all([
    session.user.advisoryFirmId
      ? prisma.advisoryFirm.findUnique({
          where: { id: session.user.advisoryFirmId },
          select: { name: true, logoDataUrl: true },
        }).catch(() => null)
      : null,
    // Solo para pintar «Equipo de soporte» en el menu de quien lo tenga.
    supportActorFor(session.user),
  ]);

  return (
    <DashboardShell
      role={role}
      userName={session.user.name ?? "Usuario"}
      userEmail={session.user.email}
      firmName={firm?.name ?? null}
      firmLogo={firm?.logoDataUrl ?? null}
      supportStaff={supportActor.staff}
    >
      {children}
    </DashboardShell>
  );
}
