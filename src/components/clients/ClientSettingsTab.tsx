import Link from "next/link";
import { BookOpen, Mail } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { ClientSheetData } from "@/lib/clientSheetData";
import { EditClientForm } from "@/app/dashboard/admin/clients/[id]/EditClientForm";
import { ClientWorkersPanel } from "@/app/dashboard/admin/clients/[id]/ClientWorkersPanel";
import { DownloadClientData } from "@/app/dashboard/admin/clients/[id]/DownloadClientData";
import { EquivalenceSurchargeConfig } from "@/app/dashboard/admin/clients/[id]/accounts/EquivalenceSurchargeConfig";
import { SimplifiedAccountsConfig } from "@/app/dashboard/admin/clients/[id]/accounts/SimplifiedAccountsConfig";

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-[14px] font-semibold text-slate-800">{title}</h2>
      {description && <p className="mt-0.5 text-[12px] text-slate-500">{description}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

/** Ajustes (solo administrador): la ficha, el regimen fiscal, los gestores y los datos. */
export async function ClientSettingsTab({ data, firmId }: { data: ClientSheetData; firmId: string }) {
  const { client, workers } = data;
  const firmWorkers = await prisma.user.findMany({
    where: { advisoryFirmId: firmId, role: "WORKER" },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <div className="space-y-5 xl:col-span-2">
        <Section title="Datos del cliente">
          <EditClientForm
            clientId={client.id}
            initial={{
              name: client.name,
              cif: client.cif,
              accountingProgram: client.accountingProgram,
              contactName: client.contactName,
              phone: client.phone,
              notes: client.notes,
            }}
          />
        </Section>

        <Section title="Régimen y cuentas por defecto" description="Lo mismo que en el plan de cuentas; está aquí para no tener que ir a buscarlo.">
          <div className="space-y-0">
            <EquivalenceSurchargeConfig clientId={client.id} initialEnabled={client.equivalenceSurchargeCustomer} />
            <SimplifiedAccountsConfig
              clientId={client.id}
              initialSupplier={client.simplifiedSupplierAccount ?? ""}
              initialExpense={client.simplifiedExpenseAccount ?? ""}
            />
          </div>
        </Section>
      </div>

      <div className="space-y-5">
        <Section title="Gestores asignados" description="Quién ve y revisa las facturas de este cliente.">
          <ClientWorkersPanel clientId={client.id} workers={firmWorkers} assignedIds={workers.map((w) => w.id)} />
        </Section>

        <Section title="Acceso al portal">
          <div className="flex items-start gap-2.5 text-[13px] text-slate-600">
            <Mail className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-300" />
            {client.email ? (
              <p>Entra con <span className="font-medium text-slate-800">{client.email}</span>.</p>
            ) : (
              <p className="italic text-slate-400">Este cliente no tiene acceso al portal: la asesoría le sube las facturas.</p>
            )}
          </div>
        </Section>

        <Section title="Plan de cuentas y datos">
          <Link
            href={`/dashboard/admin/clients/${client.id}/accounts`}
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-3.5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            <BookOpen className="h-4 w-4 text-slate-400" />
            Plan de cuentas
          </Link>
          <DownloadClientData clientId={client.id} />
        </Section>
      </div>
    </div>
  );
}
