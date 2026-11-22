import Link from "next/link";
import { AlertTriangle, Archive, ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { PendingTacoSplitsNotice } from "@/components/archive/PendingTacoSplits";
import type { ArchiveCell, ArchiveMetrics } from "@/lib/archiveMetrics";
import { archiveTabHref, clientSheetPath, type ArchiveTabQuery } from "@/lib/clientSheet";
import { formatDateEs } from "@/lib/dates";
import type { TacoAlerts } from "@/lib/tacoData";

/** Ejercicios de la matriz: los últimos siete. */
const MATRIX_YEARS = 7;

type Figure = {
  label: string;
  value: (cell: ArchiveCell) => number;
  /** El filtro de la pestaña Archivo que enseña esas facturas, si lo hay. */
  filter?: Partial<ArchiveTabQuery>;
  tone?: (n: number) => string;
  /** Debajo, en gris (y también enlaza al filtro): «+ 340 por confirmar». */
  extra?: (cell: ArchiveCell) => number;
  extraLabel?: string;
};

const FIGURES: Figure[] = [
  { label: "Facturas", value: (c) => c.invoices, filter: {} },
  { label: "Recibidas", value: (c) => c.received, filter: { type: "recibidas" } },
  { label: "Emitidas", value: (c) => c.issued, filter: { type: "emitidas" } },
  { label: "Electrónico", value: (c) => c.electronic, filter: { medium: "electronico" } },
  { label: "Papel", value: (c) => c.paper, filter: { medium: "papel" } },
  {
    label: "Sin ubicación",
    value: (c) => c.paperWithoutLocation,
    filter: { withoutLocation: true },
    tone: (n) => (n > 0 ? "text-amber-700" : ""),
    extra: (c) => c.unconfirmedWithoutLocation,
    extraLabel: "por confirmar",
  },
  { label: "Por confirmar", value: (c) => c.unconfirmed, filter: { medium: "por-confirmar" }, tone: (n) => (n > 0 ? "text-amber-700" : "") },
  { label: "Registradas", value: (c) => c.registered },
  { label: "Sin registrar", value: (c) => c.unregistered },
  { label: "Conservar más", value: (c) => c.retentionHold },
];

const n = (value: number) => value.toLocaleString("es-ES");

const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/**
 * Los avisos del Resumen (5.5), encima de la matriz y solo los que no son
 * cero: tacos enteros por dividir, tacos sin guardar en caja y lo que no tiene
 * ubicación (el papel y lo «Por confirmar», que en lo de antes del archivo es
 * casi todo el papel).
 */
export function ArchiveAlerts({ alerts }: { alerts: TacoAlerts }) {
  const { unfiled, unfiledPages, paperWithoutLocation: paper, unconfirmedWithoutLocation: unconfirmed } = alerts;
  const location = paper > 0 && unconfirmed > 0
    ? `Hay ${plural(paper, "factura", "facturas")} en papel sin ubicación y ${n(unconfirmed)} por confirmar (pueden ser papel).`
    : paper > 0
      ? `Hay ${plural(paper, "factura", "facturas")} en papel sin ubicación.`
      : unconfirmed > 0
        ? `Hay ${plural(unconfirmed, "factura", "facturas")} por confirmar sin ubicación (pueden ser papel).`
        : null;
  if (alerts.pendingSplits.length === 0 && unfiled === 0 && !location) return null;
  return (
    <div className="mb-5 space-y-3">
      <PendingTacoSplitsNotice splits={alerts.pendingSplits} wording="archive" className="" />
      {unfiled > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>
              Hay {unfiled === 1 ? "1 taco sin guardar" : `${n(unfiled)} tacos sin guardar`} en caja ({plural(unfiledPages, "página", "páginas")}).
            </span>
          </span>
          <Link
            href="/dashboard/archivo/tacos?estado=sin-guardar"
            className="inline-flex items-center gap-1 pl-6 font-semibold underline-offset-2 hover:underline sm:pl-0"
          >
            Ver los tacos
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
      {location && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
          <span>{location} Ponles ubicación desde la pestaña Archivo de cada cliente.</span>
        </p>
      )}
    </div>
  );
}

/**
 * El resumen del archivo: la matriz cliente × ejercicio (los últimos siete) y
 * el desglose del ejercicio elegido, con una fila de total. Cada cifra lleva a
 * la pestaña Archivo del cliente con el filtro puesto. Con un ejercicio que
 * no es el año natural, la columna es el año en que empieza («2025» = 2025-26).
 */
export function ArchiveSummary({
  metrics,
  role,
  selectedYear,
  hrefForYear,
}: {
  metrics: ArchiveMetrics;
  role: "ADMIN" | "WORKER";
  /** Año de inicio del ejercicio del desglose; null = el más reciente. */
  selectedYear: number | null;
  hrefForYear: (startYear: number) => string;
}) {
  const clients = metrics.clients.filter((c) => c.years.length > 0);
  if (clients.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EmptyState
          icon={Archive}
          title="El archivo está vacío"
          description="Las facturas entran en el archivo al subirlas; aquí verás cuántas hay de cada cliente y ejercicio."
        />
      </div>
    );
  }

  const columns = metrics.startYears.slice(0, MATRIX_YEARS);
  const year = selectedYear != null && metrics.startYears.includes(selectedYear) ? selectedYear : metrics.startYears[0];
  const total = metrics.totals.find((t) => t.startYear === year);
  const sheet = (clientId: string, query: Partial<ArchiveTabQuery>) =>
    archiveTabHref(clientSheetPath(role, clientId), query);
  const inYear = clients
    .map((c) => ({ client: c, cell: c.years.find((y) => y.startYear === year) }))
    .filter((row): row is { client: (typeof clients)[number]; cell: NonNullable<typeof row.cell> } => row.cell != null);

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold text-slate-800">Facturas por cliente y ejercicio</h2>
          <p className="text-[12px] text-slate-500">Pulsa un ejercicio para ver su desglose abajo.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="sticky left-0 bg-white px-4 py-3 text-left sm:px-5">Cliente</th>
                {columns.map((startYear) => (
                  <th key={startYear} className="px-3 py-3 text-right">
                    <Link
                      href={hrefForYear(startYear)}
                      aria-current={startYear === year ? "true" : undefined}
                      className={`rounded-md px-2 py-1 tabular-nums ${startYear === year ? "bg-blue-600 text-white" : "hover:text-slate-800"}`}
                    >
                      {startYear}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {clients.map((c) => (
                <tr key={c.clientId} className="hover:bg-slate-50/60">
                  <td className="sticky left-0 max-w-[220px] truncate bg-white px-4 py-2.5 font-medium text-slate-800 sm:px-5">
                    <Link href={sheet(c.clientId, {})} className="hover:text-blue-700">{c.name}</Link>
                  </td>
                  {columns.map((startYear) => {
                    const cell = c.years.find((y) => y.startYear === startYear);
                    return (
                      <td key={startYear} className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {cell ? (
                          <Link
                            href={sheet(c.clientId, { fiscalYear: startYear })}
                            title={`Ejercicio ${cell.label}`}
                            className="font-medium text-slate-700 hover:text-blue-700"
                          >
                            {n(cell.invoices)}
                            {cell.unconfirmed > 0 && (
                              <span className="ml-1 text-[11px] font-normal text-amber-600">({n(cell.unconfirmed)} por confirmar)</span>
                            )}
                          </Link>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="text-[15px] font-semibold text-slate-800">Ejercicio {year}</h2>
          <p className="text-[12px] text-slate-500">
            «Por confirmar» son escaneos o fotos de los que aún no se sabe si hay papel: no cuentan como papel. Las
            rechazadas van aparte. Sin ubicación es papel que no está en ningún taco ni lo guarda el cliente. Las «por
            confirmar» pueden ser papel o el original electrónico: al ponerles ubicación pasan a papel.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="sticky left-0 bg-white px-4 py-3 text-left sm:px-5">Cliente</th>
                {FIGURES.map((f) => (
                  <th key={f.label} className="whitespace-nowrap px-3 py-3 text-right">{f.label}</th>
                ))}
                <th className="whitespace-nowrap px-3 py-3 text-right">Conservar hasta</th>
                <th className="whitespace-nowrap px-3 py-3 text-right">Rechazadas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {inYear.map(({ client, cell }) => (
                <tr key={client.clientId} className="hover:bg-slate-50/60">
                  <td className="sticky left-0 max-w-[220px] bg-white px-4 py-2.5 sm:px-5">
                    <Link href={sheet(client.clientId, { fiscalYear: year })} className="block truncate font-medium text-slate-800 hover:text-blue-700">
                      {client.name}
                    </Link>
                    {cell.label !== String(year) && <span className="text-[11px] text-slate-400">Ejercicio {cell.label}</span>}
                  </td>
                  {FIGURES.map((f) => {
                    const value = f.value(cell);
                    const extra = f.extra?.(cell) ?? 0;
                    const href = f.filter && (value > 0 || extra > 0) ? sheet(client.clientId, { fiscalYear: year, ...f.filter }) : null;
                    return (
                      <td key={f.label} className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${f.tone?.(value) ?? "text-slate-700"}`}>
                        {href && value > 0 ? (
                          <Link href={href} className="hover:text-blue-700 hover:underline">
                            {n(value)}
                          </Link>
                        ) : value > 0 ? (
                          n(value)
                        ) : (
                          <span className="text-slate-300">0</span>
                        )}
                        {href && extra > 0 && (
                          <Link href={href} className="block text-[11px] font-normal text-slate-400 hover:text-blue-700 hover:underline">
                            + {n(extra)} {f.extraLabel}
                          </Link>
                        )}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-600">{formatDateEs(cell.retainUntil)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-600">
                    {cell.rejected > 0 ? (
                      <Link href={sheet(client.clientId, { fiscalYear: year, includeRejected: true })} className="hover:text-blue-700 hover:underline">
                        {n(cell.rejected)}
                      </Link>
                    ) : (
                      <span className="text-slate-300">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {total && (
              <tfoot>
                <tr className="border-t border-slate-200 bg-slate-50/80 font-semibold text-slate-800">
                  <td className="sticky left-0 bg-slate-50 px-4 py-2.5 sm:px-5">Total</td>
                  {FIGURES.map((f) => {
                    const extra = f.extra?.(total) ?? 0;
                    return (
                      <td key={f.label} className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {n(f.value(total))}
                        {extra > 0 && <span className="block text-[11px] font-normal text-slate-400">+ {n(extra)} {f.extraLabel}</span>}
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatDateEs(total.retainUntil)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{n(total.rejected)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
