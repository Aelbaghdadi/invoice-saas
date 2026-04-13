import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { ImportButton } from "./ImportButton";
import { AccountsTable } from "./AccountsTable";

export default async function AccountsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const { id: clientId } = await params;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      accountEntries: { orderBy: { name: "asc" } },
    },
  });
  if (!client || client.advisoryFirmId !== firmId) notFound();

  return (
    <div>
      <Link
        href={`/dashboard/admin/clients/${clientId}`}
        className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" />
        Volver a {client.name}
      </Link>

      <PageHeader
        title="Plan de Cuentas"
        description={`${client.name} — ${client.accountEntries.length} cuentas registradas`}
      />

      {/* Import + Add */}
      <div className="mb-6 flex items-start gap-4">
        <ImportButton clientId={clientId} />
      </div>

      {/* Table */}
      <AccountsTable entries={client.accountEntries} clientId={clientId} />
    </div>
  );
}
