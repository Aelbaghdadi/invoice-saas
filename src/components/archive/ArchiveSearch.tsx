import Link from "next/link";
import { ExternalLink, MapPin, SearchX } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/ui/InvoiceStatusBadge";
import { MediumBadge } from "@/components/archive/MediumBadge";
import { ArchiveSearchBox } from "@/components/archive/ArchiveSearchBox";
import { ARCHIVE_MATCH_LABELS, ARCHIVE_SEARCH_LIMIT, type ArchiveSearchResult } from "@/lib/archiveData";
import { parseArchiveQuery } from "@/lib/archiveSearchQuery";
import { formatDateEs } from "@/lib/dates";
import { formatEur } from "@/lib/format";
import { tacoLabel, type PaperLocation } from "@/lib/paperLocation";

/** El color de la ubicación: lo que falta por ubicar, en ámbar; lo que no es papel o no se sabe, en gris. */
export function locationTone(location: PaperLocation): string {
  if (location.kind === "none") return "text-amber-700";
  if (location.kind === "electronic" || location.kind === "unconfirmed") return "text-slate-400";
  return "text-slate-800";
}

/** «No hay ninguna factura…»; si se buscaba un taco, lo dice con su número. */
function emptyText(query: string): string {
  const taco = parseArchiveQuery(query).taco;
  if (taco) return `No hay facturas en el ${tacoLabel(taco.number)} (o no es de tus clientes).`;
  return `No hay ninguna factura en el archivo que case con «${query}».`;
}

/**
 * «¿Dónde está?»: la caja y, si se ha buscado, los resultados de toda la
 * asesoría (o de los clientes del gestor). Cada uno dice por qué casa; los
 * exactos van primero.
 */
export function ArchiveSearch({
  basePath,
  role,
  query,
  results,
  keep,
}: {
  basePath: string;
  role: "ADMIN" | "WORKER";
  query: string;
  /** null si no se ha buscado nada. */
  results: ArchiveSearchResult[] | null;
  keep?: Record<string, string | undefined>;
}) {
  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="mb-1 text-[15px] font-semibold text-slate-800">¿Dónde está?</h2>
      <p className="mb-3 text-[12px] text-slate-500">
        Busca en el archivo de {role === "ADMIN" ? "la asesoría" : "tus clientes"}: por nº de factura, tercero, NIF, importe, nº de
        registro, taco («T37», «T37 pág 28») o caja («caja 3»).
      </p>
      <ArchiveSearchBox basePath={basePath} initialQuery={query} keep={keep} />

      {results && (
        results.length === 0 ? (
          <div className="mt-4 flex items-center gap-2.5 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-[13px] text-slate-500">
            <SearchX className="h-4 w-4 flex-shrink-0 text-slate-400" />
            {emptyText(query)}
          </div>
        ) : (
          <>
            <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
              {results.map((r) => (
                <li key={r.invoiceId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {r.clientName} · {r.periodLabel}
                    </p>
                    <p className="mt-0.5 truncate text-[14px] font-semibold text-slate-800">
                      {r.invoiceNumber ?? <span className="font-normal italic text-slate-400">Sin nº</span>}
                      {r.thirdPartyName && <span className="font-normal text-slate-500"> · {r.thirdPartyName}</span>}
                      {r.thirdPartyCif && <span className="font-mono text-[12px] font-normal text-slate-400"> · {r.thirdPartyCif}</span>}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-500">
                      <span className="tabular-nums">{formatDateEs(r.invoiceDate)}</span>
                      <span className="text-slate-300">·</span>
                      <span className="tabular-nums font-medium text-slate-700">{formatEur(r.totalAmount)}</span>
                      <span className="text-slate-300">·</span>
                      <span>{r.type === "SALE" ? "Emitida" : "Recibida"}</span>
                      <InvoiceStatusBadge status={r.status} />
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Casa por: {r.matchedBy.map((m) => ARCHIVE_MATCH_LABELS[m]).join(", ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap sm:justify-end">
                    <div className="min-w-0 max-w-full sm:max-w-[300px] sm:text-right">
                      <p className={`font-mono text-[16px] font-bold leading-tight ${r.registerNumber ? "text-slate-900" : "text-slate-400"}`}>
                        {r.registerNumber ?? "Sin registrar"}
                      </p>
                      <p className={`mt-1 flex items-start gap-1 text-[14px] font-semibold leading-snug sm:justify-end ${locationTone(r.location)}`}>
                        <MapPin className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                        {r.location.tacoId ? (
                          <Link href={`/dashboard/archivo/tandas/${r.location.tacoId}`} className="break-words hover:text-blue-700 hover:underline">
                            {r.location.text}
                          </Link>
                        ) : (
                          <span className="break-words">{r.location.text}</span>
                        )}
                      </p>
                      <div className="mt-1 flex items-center gap-2 sm:justify-end">
                        <MediumBadge medium={r.medium} reason={r.mediumReasonLabel} />
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {r.retainUntil ? <>Conservar hasta {formatDateEs(r.retainUntil)}</> : "Conservar más"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <a
                        href={`/api/archive/invoices/${r.invoiceId}/original`}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Ver original
                      </a>
                      <Link
                        href={`/dashboard/archivo/facturas/${r.invoiceId}`}
                        className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                      >
                        Ficha
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {results.length >= ARCHIVE_SEARCH_LIMIT && (
              <p className="mt-2 text-[11px] text-slate-400">Salen las {ARCHIVE_SEARCH_LIMIT} primeras: afina la búsqueda si no está.</p>
            )}
          </>
        )
      )}
    </section>
  );
}
