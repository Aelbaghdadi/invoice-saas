import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { TacoViewer } from "@/lib/archiveAccess";
import { tacoShortLabel } from "@/lib/paperLocation";
import { pendingTacoSplits, type PendingTacoSplit } from "@/lib/tacoSplit";

/** Tacos que salen con nombre; del resto, «y N más». */
const NAMED = 3;
const TACOS_PENDING_HREF = "/dashboard/archivo/tacos?estado=por-dividir";

function pagesText(n: number): string {
  return `${n} ${n === 1 ? "página" : "páginas"}`;
}

/**
 * El aviso de los tacos enteros por dividir (5.5 y 5.9): hasta que se marca
 * dónde empieza cada factura, no se analiza nada ni se puede cerrar su
 * periodo. «Tienes…» en los paneles; «Hay…» en el Resumen del archivo.
 */
export function PendingTacoSplitsNotice({
  splits,
  wording = "panel",
  className = "mb-5",
}: {
  splits: readonly PendingTacoSplit[];
  wording?: "panel" | "archive";
  /** Margen exterior: dentro de un `space-y-*`, vacío. */
  className?: string;
}) {
  if (splits.length === 0) return null;
  const named = splits.slice(0, NAMED);
  const more = splits.length - named.length;
  const count = splits.length === 1 ? "1 taco entero" : `${splits.length} tacos enteros`;
  const lead = wording === "panel" ? `Tienes ${count} por dividir` : `Hay ${count} por dividir`;
  const list = named.map((s) => `${tacoShortLabel(s.tacoNumber)} (${s.clientName}, ${pagesText(s.pageCount)})`);

  return (
    <div role="status" className={`${className} rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900`}>
      <p className="flex items-start gap-2 text-[13px]">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
        <span>
          {lead}: {list.join(", ")}
          {more > 0 ? (
            <>
              {" "}y{" "}
              <Link href={TACOS_PENDING_HREF} className="font-medium underline hover:no-underline">
                {more} más
              </Link>
              .
            </>
          ) : (
            "."
          )}{" "}
          Hasta que se marque dónde empieza cada factura, no se analiza nada ni se puede cerrar su periodo.
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2 pl-6">
        {named.map((s) => (
          <Link
            key={s.id}
            href={`/dashboard/archivo/tandas/${s.id}/dividir`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-amber-700"
          >
            {splits.length === 1 ? "Marcar las facturas" : `${tacoShortLabel(s.tacoNumber)}: marcar las facturas`}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ))}
      </div>
    </div>
  );
}

/** El aviso de los paneles del gestor y del administrador, con los tacos que ve (B-R20). */
export async function PendingTacoSplits({ viewer, className }: { viewer: TacoViewer; className?: string }) {
  const splits = await pendingTacoSplits(viewer).catch((err) => {
    console.error("[taco entero] no se han podido leer los tacos por dividir:", err);
    return [];
  });
  return <PendingTacoSplitsNotice splits={splits} wording="panel" className={className} />;
}
