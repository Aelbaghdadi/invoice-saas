import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { Role } from "@prisma/client";

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
    >
      {children}
    </DashboardShell>
  );
}
