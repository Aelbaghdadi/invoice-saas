import Link from "next/link";
import { AlertTriangle, Archive, Info, MapPin } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { ArchiveFilters } from "@/components/archive/ArchiveFilters";
import { DownloadArchiveZip } from "@/components/archive/DownloadArchiveZip";
import { PlacePaperButton } from "@/components/archive/PlacePaperButton";
import { loadClientArchive } from "@/lib/archiveData";
import { ARCHIVE_EDIT_MAX_INVOICES } from "@/lib/archiveEdits";
import { boxLabelPrefix } from "@/lib/boxProposal";
import { archiveTabHref, clientSheetHref, parseArchiveTabParams, type ArchiveTabParams, type ArchiveTabQuery } from "@/lib/clientSheet";
import { formatDateEs } from "@/lib/dates";
import { ClientArchiveTable } from "./ClientArchiveTable";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-ES")} ${n === 1 ? one : many}`;

type Figure = { text: string; href?: string; extra?: { text: string; href: string } };

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
    filters: {
      type: query.type,
      medium: query.medium,
      includeRejected: query.includeRejected,
      withoutLocation: query.withoutLocation,
      q: query.q,
    },
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
  const withoutLocationHref = inYear({ withoutLocation: true });
  const n = (value: number) => value.toLocaleString("es-ES");
  const figures: Figure[] = [
    { text: plural(summary.invoices, "factura", "facturas"), href: inYear() },
    { text: plural(summary.received, "recibida", "recibidas"), href: inYear({ type: "recibidas" }) },
    { text: plural(summary.issued, "emitida", "emitidas"), href: inYear({ type: "emitidas" }) },
    { text: `${n(summary.electronic)} electrónico`, href: inYear({ medium: "electronico" }) },
    {
      text: `${n(summary.paper)} papel`,
      href: inYear({ medium: "papel" }),
      extra: summary.paperWithoutLocation > 0 ? { text: `${n(summary.paperWithoutLocation)} sin ubicación`, href: withoutLocationHref } : undefined,
    },
    {
      text: `${n(summary.unconfirmed)} por confirmar`,
      href: inYear({ medium: "por-confirmar" }),
      extra: summary.unconfirmedWithoutLocation > 0
        ? { text: `${n(summary.unconfirmedWithoutLocation)} sin ubicación`, href: withoutLocationHref }
        : undefined,
    },
    { text: plural(summary.registered, "registrada", "registradas") },
    { text: `${n(summary.unregistered)} sin registrar` },
    { text: `${n(summary.retentionHold)} conservar más` },
  ];
  // «12 facturas en papel sin ubicación · 340 por confirmar (pueden ser papel).»
  const toPlace = [
    summary.paperWithoutLocation > 0 ? `${plural(summary.paperWithoutLocation, "factura", "facturas")} en papel sin ubicación` : null,
    summary.unconfirmedWithoutLocation > 0 ? `${n(summary.unconfirmedWithoutLocation)} por confirmar (pueden ser papel)` : null,
  ].filter((part): part is string => part != null);
  const filtered = query.type !== "todas" || query.medium !== "todos" || query.withoutLocation || !!query.q;
  // La pestaña Facturas filtra por año natural: con otro ejercicio, el enlace
  // no puede prometer solo las de este ejercicio.
  const naturalYear = archive.client.fiscalYearStartMonth === 1;
  const pendingHref = clientSheetHref(basePath, { tab: "facturas", estado: "pendientes", year: naturalYear ? fiscalYear.startYear : undefined });
  const tableKey = [fiscalYear.startYear, query.type, query.medium, query.includeRejected, query.withoutLocation, query.q, window.page].join("|");
  // La caja en la tabla, sin el «{cliente} · {ejercicio} · » que en esta pestaña ya se sabe (B-R12).
  const boxPrefix = boxLabelPrefix({ mode: "PER_CLIENT_YEAR", clientName: archive.client.name, fiscalYearLabel: fiscalYear.label });

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
              {f.extra && (
                <>
                  {" ("}
                  <Link href={f.extra.href} className="font-medium text-amber-700 hover:text-blue-700">{f.extra.text}</Link>
                  {")"}
                </>
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

      {toPlace.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-[13px] text-amber-900">
            <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>{toPlace.join(" · ")}.</span>
          </p>
          <PlacePaperButton
            target={{
              clientId: archive.client.id,
              fiscalYear: fiscalYear.startYear,
              paperCount: summary.paperWithoutLocation,
              unconfirmedCount: summary.unconfirmedWithoutLocation,
            }}
            clientId={archive.client.id}
            fiscalYear={fiscalYear.startYear}
            label="Poner ubicación a todas…"
          />
        </div>
      )}

      <ArchiveFilters
        basePath={basePath}
        fiscalYear={fiscalYear.startYear}
        values={{
          type: query.type,
          medium: query.medium,
          includeRejected: query.includeRejected,
          withoutLocation: query.withoutLocation,
          q: query.q,
        }}
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
              place={{ clientId: archive.client.id, fiscalYear: fiscalYear.startYear, boxPrefix }}
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
