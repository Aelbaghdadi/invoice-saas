import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { SettingsForm } from "./SettingsForm";
import { formatDateEs } from "@/lib/dates";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  // Fetch firm data
  const firm = await prisma.advisoryFirm.findFirst({
    where: { users: { some: { id: session.user.id } } },
  });

  // Fetch user profile
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true },
  });

  // Fetch team members (all users in this firm)
  const teamUsers = firm
    ? await prisma.user.findMany({
        where: { advisoryFirmId: firm.id },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      })
    : [];

  return (
    // Ancho contenido: tabs (200px) + formulario (~730px). Sin esto la card
    // se estira por toda la pantalla y el contenido queda perdido.
    <div className="max-w-[980px]">
      <PageHeader
        title="Ajustes"
        description="Configura los datos de tu asesoría, perfil y equipo"
      />

      <SettingsForm
        firm={{
          name: firm?.name ?? "",
          cif: firm?.cif ?? "",
          logoDataUrl: firm?.logoDataUrl ?? null,
        }}
        profile={{
          name: user?.name ?? "",
          email: user?.email ?? "",
        }}
        team={teamUsers.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          createdAt: formatDateEs(u.createdAt),
        }))}
      />
    </div>
  );
}
