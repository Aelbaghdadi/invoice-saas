import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) redirect("/login");

  switch (session.user.role) {
    case "ADMIN":
      redirect("/dashboard/admin");
    case "WORKER":
      redirect("/dashboard/worker");
    case "CLIENT":
      redirect("/dashboard/client");
    default:
      redirect("/login");
  }
}
