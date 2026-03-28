import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExportForm } from "./ExportForm";
import { Download } from "lucide-react";

export default async function ExportPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  const clients = await prisma.client.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, cif: true },
  });

  if (clients.length === 0) {
    return (
      <div>
        <h1 className="mb-1 text-[20px] font-bold text-slate-900">Exportar facturas</h1>
        <p className="mb-6 text-[13px] text-slate-400">
          Genera archivos CSV compatibles con tu software contable
        </p>
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-400">
          <Download className="mb-3 h-10 w-10 opacity-30" />
          <p className="text-[14px] font-medium">No hay clientes registrados</p>
          <p className="text-[13px]">Crea un cliente primero para poder exportar facturas.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[20px] font-bold text-slate-900">Exportar facturas</h1>
        <p className="mt-1 text-[13px] text-slate-400">
          Genera archivos CSV listos para importar en Sage 50, Contasol o a3con
        </p>
      </div>

      <ExportForm clients={clients} />
    </div>
  );
}
