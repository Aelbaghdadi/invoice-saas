import { FileQuestion } from "lucide-react";
import Link from "next/link";

export default function DashboardNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-full bg-slate-100 p-4">
        <FileQuestion className="h-8 w-8 text-slate-400" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-slate-800">Página no encontrada</h2>
      <p className="mb-6 text-[13px] text-slate-500">
        La página que buscas no existe o ha sido movida.
      </p>
      <Link
        href="/dashboard/admin"
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-blue-700"
      >
        Volver al dashboard
      </Link>
    </div>
  );
}
