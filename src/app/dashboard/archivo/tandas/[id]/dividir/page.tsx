import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import TacoSplitPicker from "@/components/archive/TacoSplitPickerDynamic";
import { canAccessUploadBatch } from "@/lib/archiveAccess";
import { tacoLabel } from "@/lib/paperLocation";
import { loadTacoToSplit } from "@/lib/tacoSplit";
import { TACO_SPLIT_MAX_PARTS } from "@/lib/tacoSplitPlan";
import { tacoLotLabel } from "@/lib/tacoSplitReview";

type Props = { params: Promise<{ id: string }> };

/**
 * «Marca dónde empieza cada factura» de un taco entero (5.8). Comprueba el rol
 * y el acceso ella misma (B-R20): sin acceso, 404. Un taco ya dividido o
 * anulado lleva a su detalle.
 */
export default async function TacoSplitPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") redirect("/dashboard");
  const firmId = session.user.advisoryFirmId;
  if (!firmId) notFound();

  const { id } = await params;
  if (!(await canAccessUploadBatch(session, id))) notFound();
  const taco = await loadTacoToSplit(firmId, id);
  if (!taco) notFound();
  const detail = `/dashboard/archivo/tandas/${id}`;
  if (taco.done) redirect(detail);

  const lotLabel = tacoLotLabel(taco);
  const pages = `${taco.pageCount} ${taco.pageCount === 1 ? "página" : "páginas"}`;
  return (
    <div>
      <Link href={detail} className="mb-3 inline-flex items-center gap-1 text-[13px] text-slate-500 hover:text-slate-800">
        <ChevronLeft className="h-4 w-4" />
        Volver al {tacoLabel(taco.tacoNumber)}
      </Link>
      <PageHeader
        title={`${tacoLabel(taco.tacoNumber)}: marca dónde empieza cada factura`}
        description={`${taco.clientName} · ${lotLabel} · ${pages}. Pulsa en la primera página de cada factura. Las páginas que siguen van con ella hasta la siguiente marca. Como mucho ${TACO_SPLIT_MAX_PARTS} facturas por taco.`}
      />
      <TacoSplitPicker
        batchId={taco.id}
        tacoNumber={taco.tacoNumber}
        clientName={taco.clientName}
        lotLabel={lotLabel}
        pageCount={taco.pageCount}
        pdfUrl={`/api/archive/tacos/${taco.id}/pdf`}
      />
    </div>
  );
}
