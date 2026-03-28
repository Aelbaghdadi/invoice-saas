import { PageHeader } from "@/components/ui/PageHeader";
import { WorkerForm } from "../WorkerForm";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export default function NewWorkerPage() {
  return (
    <div>
      <Link href="/dashboard/admin/workers" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Volver a gestores
      </Link>
      <PageHeader title="Nuevo gestor" description="Crea una cuenta de gestor y asigna clientes." />
      <div className="max-w-xl">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <WorkerForm />
        </div>
      </div>
    </div>
  );
}
