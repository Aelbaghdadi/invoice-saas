import { auth } from "@/lib/auth";
import { FileQuestion } from "lucide-react";
import Link from "next/link";

export default async function DashboardNotFound() {
  const session = await auth();
  const role = session?.user?.role;

  const homeHref =
    role === "ADMIN" ? "/dashboard/admin"
    : role === "WORKER" ? "/dashboard/worker"
    : role === "CLIENT" ? "/dashboard/client"
    : "/login";

  const homeLabel =
    role === "ADMIN" ? "Panel de administración"
    : role === "WORKER" ? "Panel del gestor"
    : role === "CLIENT" ? "Panel del cliente"
    : "Iniciar sesión";

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-full bg-slate-100 p-4">
        <FileQuestion className="h-8 w-8 text-slate-400" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-slate-800">Página no encontrada</h2>
      <p className="mb-6 max-w-md text-[13px] text-slate-500">
        La página que buscas no existe o ya no está disponible. Es posible que la factura o
        cliente haya sido eliminado, o que el enlace esté incorrecto.
      </p>
      <Link
        href={homeHref}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-blue-700"
      >
        Volver a {homeLabel}
      </Link>
    </div>
  );
}
