import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Ban, ChevronLeft, Loader2 } from "lucide-react";
import { auth } from "@/lib/auth";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { Badge } from "@/components/ui/Badge";
import { TacoDetailActions } from "@/components/archive/TacoDetailActions";
import { TacoSlotsTable } from "@/components/archive/TacoSlotsTable";
import { canAccessUploadBatch, tacoViewer } from "@/lib/archiveAccess";
import { formatDayEs } from "@/lib/dates";
import { loadTacoDetail, type TacoDetail } from "@/lib/tacoData";
import { tacoCountsLine, tacoDetailTitle } from "@/lib/tacoDetailText";
import { invoiceCountText } from "@/lib/tacoSplitReview";
import { TACOS_PATH } from "@/lib/tacoListParams";
import type { UploadMeta } from "@/lib/uploadDirectClient";

type Props = { params: Promise<{ id: string }> };

/** Dónde está el papel del taco: la insignia grande de la cabecera. */
function destination(detail: TacoDetail): { text: string; variant: "yellow" | "blue" | "slate" } | null {
  if (detail.kind === "digital" || detail.voidedAt) return null;
  if (detail.boxLabel) {
    return { text: `En «${detail.boxLabel}»${detail.filedAt ? ` desde el ${formatDayEs(detail.filedAt)}` : ""}`, variant: "blue" };
  }
  if (detail.returnedAt) return { text: `Devuelto al cliente el ${formatDayEs(detail.returnedAt)}`, variant: "slate" };
  return { text: "Sin guardar", variant: "yellow" };
}

/** Lo que lleva cada subida de «Completar el taco»: el cliente (o los candidatos que ve), el lote y el tipo del taco. */
function completeMeta(detail: TacoDetail): UploadMeta | null {
  if (!detail.lot) return null;
  const base = {
    periodType: detail.lot.periodType,
    periodMonth: detail.lot.periodMonth,
    periodYear: detail.lot.periodYear,
    type: detail.lot.invoiceType,
  };
  if (detail.client) return { ...base, clientId: detail.client.id };
  if (detail.completeCandidateIds.length === 0) return null;
  return { ...base, candidateClientIds: detail.completeCandidateIds };
}

/**
 * Detalle de una tanda o taco (5.7): de dónde es, dónde está su papel, sus
 * páginas con sus facturas y huecos, y lo que se puede hacer con él. La
 * propia página comprueba el rol y el acceso (B-R20): sin acceso, 404.
 */
export default async function TacoDetailPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "WORKER") redirect("/dashboard");
  const viewer = await tacoViewer(session);
  if (!viewer) notFound();

  const { id } = await params;
  if (!(await canAccessUploadBatch(session, id))) notFound();
  const detail = await loadTacoDetail(viewer, id);
  if (!detail) notFound();

  const title = tacoDetailTitle(detail);
  const dest = destination(detail);
  const meta = detail.canComplete ? completeMeta(detail) : null;
  const takenPages = detail.slots.filter((slot) => slot.kind !== "empty").map((slot) => slot.page);
  const empty = detail.kind === "taco" ? detail.slots.length === 0 : detail.rows.length === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        href={detail.kind === "digital" ? `${TACOS_PATH}?estado=digitales` : TACOS_PATH}
        className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" />
        Volver a los tacos
      </Link>

      <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-[22px] font-bold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-1 text-[13px] text-slate-600">
              <span className="font-medium text-slate-800">{detail.client?.name ?? "Varios clientes"}</span>
              {" · "}{detail.lotLabel}
              {" · "}subido el {formatDayEs(detail.createdAt)}
              {detail.createdByName ? ` por ${detail.createdByName}` : ""}
            </p>
            <p className="mt-0.5 text-[13px] text-slate-500">{tacoCountsLine(detail)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dest && <Badge variant={dest.variant}>{dest.text}</Badge>}
            {detail.canSplit && <Badge variant="yellow">Por dividir</Badge>}
          </div>
        </div>

        {detail.voidedAt && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-[13px] text-slate-700">
            <Ban className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-500" />
            <span>
              Anulado el {formatDayEs(detail.voidedAt)}
              {detail.voidedByName ? ` por ${detail.voidedByName}` : ""}: {detail.voidReason}
            </span>
          </p>
        )}

        {detail.analyzingCount > 0 && (
          <p role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[12px] text-blue-800">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Hay {invoiceCountText(detail.analyzingCount)} analizándose: esta página se actualiza sola.
            <AutoRefresh signature={detail.statusSignature} />
          </p>
        )}

        <TacoDetailActions
          batchId={detail.id}
          tacoNumber={detail.tacoNumber}
          canFile={detail.canFile}
          filed={detail.boxLabel != null || detail.returnedAt != null}
          current={{ boxLabel: detail.boxLabel, returnedAt: detail.returnedAt ? detail.returnedAt.toISOString() : null }}
          canSplit={detail.canSplit}
          tacoPdfUrl={detail.tacoPdfUrl}
          canConvert={detail.canConvert}
          canVoid={detail.canVoid}
          complete={meta ? { fileCount: detail.fileCount, occupied: detail.occupied, takenPages, meta } : null}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {detail.kind === "taco" && detail.wholePdf && !detail.split ? (
          <p className="px-5 py-8 text-center text-[13px] text-slate-500">
            {detail.voidedAt
              ? "Este taco se anuló sin dividir: no tiene facturas."
              : "Falta marcar dónde empieza cada factura: hasta entonces no se analiza nada."}
          </p>
        ) : empty ? (
          <p className="px-5 py-8 text-center text-[13px] text-slate-500">
            {detail.kind === "archive" ? "Todavía no hay papel en este taco." : "No llegó ninguna factura en esta subida."}
          </p>
        ) : (
          <TacoSlotsTable detail={detail} />
        )}
      </div>
    </div>
  );
}
