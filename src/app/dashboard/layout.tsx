import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { Role } from "@prisma/client";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrador",
  WORKER: "Gestor",
  CLIENT: "Cliente",
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const role = session.user.role as Role;

  return (
    <DashboardShell
      role={role}
      userName={session.user.name ?? "Usuario"}
      userEmail={session.user.email}
      userRole={ROLE_LABELS[role]}
    >
      {children}
    </DashboardShell>
  );
}
