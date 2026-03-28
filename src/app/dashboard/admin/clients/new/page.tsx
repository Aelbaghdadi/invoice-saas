import { PageHeader } from "@/components/ui/PageHeader";
import { ClientForm } from "../ClientForm";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export default function NewClientPage() {
  return (
    <div>
      <Link
        href="/dashboard/admin/clients"
        className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700"
      >
        <ChevronLeft className="h-4 w-4" />
        Volver a clientes
      </Link>
      <PageHeader
        title="Nuevo cliente"
        description="Registra una nueva empresa en tu asesoría."
      />
      <div className="max-w-xl">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <ClientForm />
        </div>
      </div>
    </div>
  );
}
