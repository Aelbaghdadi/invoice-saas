import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { SettingsForm } from "./SettingsForm";

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
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-bold text-slate-900">Ajustes</h1>
        <p className="mt-1 text-[13px] text-slate-400">
          Configura los datos de tu asesoría, perfil y equipo
        </p>
      </div>

      <SettingsForm
        firm={{
          name: firm?.name ?? "",
          cif: firm?.cif ?? "",
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
          createdAt: u.createdAt.toISOString().slice(0, 10),
        }))}
      />
    </div>
  );
}
