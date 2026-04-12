import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Lock, Unlock, CalendarCheck } from "lucide-react";
import { ClosuresClient } from "./ClosuresClient";

const MONTHS = [
  "", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export default async function ClosuresPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const firmId = session.user.advisoryFirmId ?? undefined;

  const [clients, closures] = await Promise.all([
    prisma.client.findMany({
      where: { advisoryFirmId: firmId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cif: true },
    }),
    prisma.periodClosure.findMany({
      where: { client: { advisoryFirmId: firmId } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      include: { client: { select: { name: true, cif: true } } },
      take: 100,
    }),
  ]);

  const activeClosed = closures.filter((c) => !c.reopenedAt);
  const history = closures;

  return (
    <div>
      <PageHeader
        title="Cierres de periodo"
        description="Cierra periodos mensuales para impedir modificaciones. Los recordatorios se envían automáticamente."
      />

      <ClosuresClient
        clients={clients.map((c) => ({ id: c.id, name: c.name, cif: c.cif }))}
      />

      {/* Active closures */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <Lock className="h-4 w-4 text-red-500" />
          <h2 className="text-[14px] font-semibold text-slate-800">
            Periodos cerrados activos ({activeClosed.length})
          </h2>
        </div>
        {activeClosed.length === 0 ? (
          <EmptyState
            icon={CalendarCheck}
            title="Sin cierres activos"
            description="No hay periodos cerrados actualmente."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Periodo</th>
                  <th className="px-5 py-3">Cerrado</th>
                  <th className="px-5 py-3">Recordatorio</th>
                  <th className="px-5 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {activeClosed.map((c) => (
                  <tr key={c.id} className="text-slate-700 hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-medium">{c.client.name}</td>
                    <td className="px-5 py-3">{MONTHS[c.month]} {c.year}</td>
                    <td className="px-5 py-3 text-[12px] text-slate-500">
                      {c.closedAt.toLocaleDateString("es-ES")}
                    </td>
                    <td className="px-5 py-3">
                      {c.reminderSent ? (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-600">Enviado</span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-600">Pendiente</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <form action={async (fd: FormData) => {
                        "use server";
                        const { reopenPeriod } = await import("./actions");
                        await reopenPeriod(fd);
                      }}>
                        <input type="hidden" name="closureId" value={c.id} />
                        <button
                          type="submit"
                          className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600 transition hover:bg-slate-100"
                        >
                          <Unlock className="h-3 w-3" />
                          Reabrir
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <CalendarCheck className="h-4 w-4 text-slate-400" />
            <h2 className="text-[14px] font-semibold text-slate-800">
              Historial completo
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-5 py-3">Cliente</th>
                  <th className="px-5 py-3">Periodo</th>
                  <th className="px-5 py-3">Estado</th>
                  <th className="px-5 py-3">Cerrado</th>
                  <th className="px-5 py-3">Reabierto</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {history.map((c) => (
                  <tr key={c.id} className="text-slate-700 hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-medium">{c.client.name}</td>
                    <td className="px-5 py-3">{MONTHS[c.month]} {c.year}</td>
                    <td className="px-5 py-3">
                      {c.reopenedAt ? (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">Reabierto</span>
                      ) : (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Cerrado</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-500">
                      {c.closedAt.toLocaleDateString("es-ES")}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-slate-500">
                      {c.reopenedAt ? c.reopenedAt.toLocaleDateString("es-ES") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
