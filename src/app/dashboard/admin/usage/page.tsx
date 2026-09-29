import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PageHeader } from "@/components/ui/PageHeader";
import { usageReport } from "@/lib/usageReport";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MESES[m - 1][0].toUpperCase()}${MESES[m - 1].slice(1)} ${y}`;
}

const n = (value: number) => value.toLocaleString("es-ES");

/** Uso de la asesoría por mes (F-043): solo lo que ya se guarda, sin planes ni límites. */
export default async function UsagePage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  if (!session.user.advisoryFirmId) redirect("/dashboard/admin");

  const months = await usageReport(session.user.advisoryFirmId);
  const current = months[0];
  const cards = [
    { label: "Facturas subidas", value: current.uploaded },
    { label: "Análisis de OCR", value: current.ocrAnalyses },
    { label: "Validadas", value: current.validated },
    { label: "Exportadas", value: current.exported },
  ];
  const columns = [
    "Mes", "Subidas", "Análisis de OCR", "De ellos, reprocesos", "Acabaron en «Error OCR»", "XML sin OCR",
    "Validadas", "Exportadas", "Clientes", "Usuarios de la asesoría", "Usuarios del portal",
  ];

  return (
    <div>
      <PageHeader
        title="Uso"
        description={`Lo que ha hecho la asesoría cada mes. Mes actual: ${monthLabel(current.month).toLowerCase()}.`}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-[12px] font-medium uppercase tracking-wide text-slate-400">{c.label}</p>
            <p className="mt-2 text-2xl font-bold tabular-nums text-slate-900">{n(c.value)}</p>
            <p className="mt-1 text-[11px] text-slate-400">este mes</p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80">
              {columns.map((h, i) => (
                <th key={h} className={`px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {months.map((m, i) => (
              <tr key={m.month} className={i === 0 ? "bg-blue-50/40" : undefined}>
                <td className="whitespace-nowrap px-4 py-2.5 text-[13px] font-medium text-slate-700">{monthLabel(m.month)}</td>
                {[m.uploaded, m.ocrAnalyses, m.ocrReprocesses, m.ocrFailures, m.xmlParsed, m.validated, m.exported, m.clients, m.staffUsers, m.portalUsers].map((v, j) => (
                  <td key={j} className="px-4 py-2.5 text-right text-[13px] tabular-nums text-slate-600">{n(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 space-y-1 text-[12px] text-slate-500">
        <p>
          <strong>Análisis de OCR:</strong> las lecturas con Gemini o Document AI, también las que acabaron en «Error OCR»,
          salvo las que no llegaron a enviarse (el original no se pudo descargar). Un fallo del almacenamiento a mitad de la
          descarga no se distingue de uno del proveedor y sí cuenta. Los reintentos automáticos dentro de una misma lectura
          (por ejemplo, cuando el proveedor pide esperar) no se guardan y no están contados: contarlos necesita guardar un
          dato nuevo.
        </p>
        <p><strong>XML sin OCR:</strong> las facturas electrónicas (Facturae) se leen directamente, sin gastar OCR.</p>
        <p><strong>Validadas y exportadas:</strong> facturas distintas; una que se valida o exporta dos veces el mismo mes cuenta una.</p>
        <p><strong>Clientes y usuarios:</strong> los que había a final de cada mes.</p>
      </div>
    </div>
  );
}
