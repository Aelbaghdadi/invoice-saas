import Link from "next/link";
import { Archive } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ArchiveCell, ArchiveMetrics } from "@/lib/archiveMetrics";
import { archiveTabHref, clientSheetPath, type ArchiveTabQuery } from "@/lib/clientSheet";
import { formatDateEs } from "@/lib/dates";

/** Ejercicios de la matriz: los últimos siete. */
const MATRIX_YEARS = 7;

type Figure = {
  label: string;
  value: (cell: ArchiveCell) => number;
  /** El filtro de la pestaña Archivo que enseña esas facturas, si lo hay. */
  filter?: Partial<ArchiveTabQuery>;
  tone?: (n: number) => string;
};

const FIGURES: Figure[] = [
  { label: "Facturas", value: (c) => c.invoices, filter: {} },
  { label: "Recibidas", value: (c) => c.received, filter: { type: "recibidas" } },
  { label: "Emitidas", value: (c) => c.issued, filter: { type: "emitidas" } },
  { label: "Electrónico", value: (c) => c.electronic, filter: { medium: "electronico" } },
  { label: "Papel", value: (c) => c.paper, filter: { medium: "papel" } },
  { label: "Por confirmar", value: (c) => c.unconfirmed, filter: { medium: "por-confirmar" }, tone: (n) => (n > 0 ? "text-amber-700" : "") },
  { label: "Registradas", value: (c) => c.registered },
  { label: "Sin registrar", value: (c) => c.unregistered },
  { label: "Conservar más", value: (c) => c.retentionHold },
];

const n = (value: number) => value.toLocaleString("es-ES");

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
            rechazadas van aparte.
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
                    return (
                      <td key={f.label} className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${f.tone?.(value) ?? "text-slate-700"}`}>
                        {f.filter && value > 0 ? (
                          <Link href={sheet(client.clientId, { fiscalYear: year, ...f.filter })} className="hover:text-blue-700 hover:underline">
                            {n(value)}
                          </Link>
                        ) : value > 0 ? (
                          n(value)
                        ) : (
                          <span className="text-slate-300">0</span>
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
                  {FIGURES.map((f) => (
                    <td key={f.label} className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{n(f.value(total))}</td>
                  ))}
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
