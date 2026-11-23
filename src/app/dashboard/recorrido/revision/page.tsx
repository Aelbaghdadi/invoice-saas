import Link from "next/link";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { Upload } from "lucide-react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { hasTour } from "@/lib/tourSteps";
import { PageHeader } from "@/components/ui/PageHeader";

/**
 * La parte de revisión del recorrido: abre una factura por revisar de los
 * clientes de quien lo hace (la de más tipos de IVA, que es la que más
 * enseña). Sin ninguna, se queda aquí y el recorrido lo explica.
 */
export default async function TourReviewPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role as Role;
  if (!hasTour(role)) redirect("/dashboard/client");

  const clientIds = await getAccessibleClientIds(session);
  const invoice = clientIds.length
    ? await prisma.invoice.findFirst({
        where: { clientId: { in: clientIds }, status: { in: ["PENDING_REVIEW", "NEEDS_ATTENTION"] } },
        orderBy: [{ vatLines: { _count: "desc" } }, { createdAt: "asc" }],
        select: { id: true },
      })
    : null;
  if (invoice) redirect(`/dashboard/worker/review/${invoice.id}`);

  return (
    <div>
      <PageHeader title="Revisión" description="Aquí se abriría una factura por revisar." />
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <p className="text-[14px] font-medium text-slate-700">Ahora mismo no hay ninguna factura por revisar.</p>
        <p className="mt-1 text-[13px] text-slate-500">Sube una y se leerá sola en unos momentos.</p>
        <Link
          href="/dashboard/worker/upload"
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-700"
        >
          <Upload className="h-4 w-4" />
          Subir facturas
        </Link>
      </div>
    </div>
  );
}
