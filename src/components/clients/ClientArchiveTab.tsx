import Link from "next/link";
import { AlertTriangle, Archive, Info } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { ArchiveFilters } from "@/components/archive/ArchiveFilters";
import { DownloadArchiveZip } from "@/components/archive/DownloadArchiveZip";
import { loadClientArchive } from "@/lib/archiveData";
import { ARCHIVE_EDIT_MAX_INVOICES } from "@/lib/archiveEdits";
import { archiveTabHref, clientSheetHref, parseArchiveTabParams, type ArchiveTabParams, type ArchiveTabQuery } from "@/lib/clientSheet";
import { formatDateEs } from "@/lib/dates";
import { ClientArchiveTable } from "./ClientArchiveTable";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;

/**
 * El archivo del cliente en un ejercicio: sus cifras, los filtros y la tabla
 * en el orden del archivo. Lo ven el administrador y el gestor; el acceso al
 * cliente ya lo ha comprobado la ficha. La descarga del ejercicio en ZIP es
 * solo del administrador (`canDownloadZip`; la ruta lo vuelve a mirar).
 */
export async function ClientArchiveTab({
  clientId,
  firmId,
  basePath,
  params,
  canDownloadZip = false,
}: {
  clientId: string;
  firmId: string;
  basePath: string;
  params: ArchiveTabParams;
  canDownloadZip?: boolean;
}) {
  const query = parseArchiveTabParams(params);
  const archive = await loadClientArchive({
    firmId,
    clientId,
    fiscalYear: query.fiscalYear,
    filters: { type: query.type, medium: query.medium, includeRejected: query.includeRejected, q: query.q },
    page: query.page,
    selectionLimit: ARCHIVE_EDIT_MAX_INVOICES,
  });
  if (!archive) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState icon={Archive} title="Sin archivo" description="Este cliente no tiene archivo de facturas." />
      </div>
    );
  }

  const { fiscalYear, summary, window } = archive;
  const years = archive.fiscalYears.some((y) => y.startYear === fiscalYear.startYear)
    ? archive.fiscalYears
    : [fiscalYear, ...archive.fiscalYears].sort((a, b) => b.startYear - a.startYear);
  const inYear = (extra: Partial<ArchiveTabQuery> = {}) => archiveTabHref(basePath, { fiscalYear: fiscalYear.startYear, ...extra });
  const figures: { text: string; href?: string }[] = [
    { text: plural(summary.invoices, "factura", "facturas"), href: inYear() },
    { text: plural(summary.received, "recibida", "recibidas"), href: inYear({ type: "recibidas" }) },
    { text: plural(summary.issued, "emitida", "emitidas"), href: inYear({ type: "emitidas" }) },
    { text: `${summary.electronic.toLocaleString("es-ES")} electrónico`, href: inYear({ medium: "electronico" }) },
    { text: `${summary.paper.toLocaleString("es-ES")} papel`, href: inYear({ medium: "papel" }) },
    { text: `${summary.unconfirmed.toLocaleString("es-ES")} por confirmar`, href: inYear({ medium: "por-confirmar" }) },
    { text: plural(summary.registered, "registrada", "registradas") },
    { text: `${summary.unregistered.toLocaleString("es-ES")} sin registrar` },
    { text: `${summary.retentionHold.toLocaleString("es-ES")} conservar más` },
  ];
  const filtered = query.type !== "todas" || query.medium !== "todos" || !!query.q;
  // La pestaña Facturas filtra por año natural: con otro ejercicio, el enlace
  // no puede prometer solo las de este ejercicio.
  const naturalYear = archive.client.fiscalYearStartMonth === 1;
  const pendingHref = clientSheetHref(basePath, { tab: "facturas", estado: "pendientes", year: naturalYear ? fiscalYear.startYear : undefined });
  const tableKey = [fiscalYear.startYear, query.type, query.medium, query.includeRejected, query.q, window.page].join("|");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Ejercicio</span>
          <div className="flex flex-wrap items-center gap-1">
            {years.map((y) => {
              const active = y.startYear === fiscalYear.startYear;
              return (
                <Link
                  key={y.startYear}
                  href={archiveTabHref(basePath, { fiscalYear: y.startYear })}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-md px-2.5 py-1 text-[13px] font-semibold tabular-nums transition-colors ${
                    active ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {y.label}
                </Link>
              );
            })}
          </div>
          {canDownloadZip && (
            <DownloadArchiveZip
              key={fiscalYear.startYear}
              clientId={archive.client.id}
              fiscalYear={fiscalYear}
              fiscalYearStartMonth={archive.client.fiscalYearStartMonth}
            />
          )}
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-slate-600">
          {figures.map((f, i) => (
            <span key={f.text}>
              {i > 0 && <span className="text-slate-300"> · </span>}
              {f.href ? (
                <Link href={f.href} className="font-medium text-slate-800 hover:text-blue-700">{f.text}</Link>
              ) : (
                <span className="font-medium text-slate-800">{f.text}</span>
              )}
            </span>
          ))}
          <span className="text-slate-300"> · </span>
          <span className="font-medium text-slate-800">
            Conservar hasta {summary.retainUntil ? formatDateEs(summary.retainUntil) : "—"}
          </span>
        </p>
        {summary.rejected > 0 && (
          <p className="mt-1 text-[12px] text-slate-500">
            Aparte,{" "}
            <Link href={inYear({ includeRejected: true })} className="font-medium text-slate-700 hover:text-blue-700">
              {plural(summary.rejected, "rechazada", "rechazadas")}
            </Link>
            , que también se conservan.
          </p>
        )}

        {summary.pendingValidation > 0 && (
          <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              Hay {plural(summary.pendingValidation, "factura", "facturas")} de este ejercicio sin validar.{" "}
              <Link href={pendingHref} className="font-semibold underline-offset-2 hover:underline">
                {naturalYear ? "Ver las pendientes" : "Ver las pendientes del cliente"}
              </Link>
            </span>
          </p>
        )}
        <p className="mt-3 flex items-start gap-2 text-[11px] text-slate-400">
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
          El nº de registro es del archivo, no el de A3: se pone la primera vez que la factura sale en un Excel para A3.
        </p>
      </div>

      <ArchiveFilters
        basePath={basePath}
        fiscalYear={fiscalYear.startYear}
        values={{ type: query.type, medium: query.medium, includeRejected: query.includeRejected, q: query.q }}
      />

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        {archive.rows.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="Sin facturas"
            description={filtered ? "No hay facturas con estos filtros en este ejercicio." : `El ejercicio ${fiscalYear.label} no tiene facturas en el archivo.`}
          />
        ) : (
          <>
            <ClientArchiveTable
              key={tableKey}
              rows={archive.rows}
              periods={archive.periods}
              typeFilter={query.type}
              selectable={{ ids: archive.selectableIds, total: window.total, filtered }}
            />
            <Pagination
              window={window}
              noun="facturas"
              hrefFor={(page) => archiveTabHref(basePath, { ...query, fiscalYear: fiscalYear.startYear, page })}
            />
          </>
        )}
      </div>
    </div>
  );
}
