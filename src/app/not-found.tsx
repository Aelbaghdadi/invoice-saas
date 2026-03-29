import Link from "next/link";
import { Receipt } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <div className="flex items-center gap-2.5 mb-8">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600">
          <Receipt className="h-4 w-4 text-white" />
        </div>
        <span className="text-[17px] font-bold text-slate-800">FacturOCR</span>
      </div>

      <p className="text-7xl font-extrabold text-blue-600">404</p>
      <h1 className="mt-4 text-xl font-bold text-slate-800">
        Pagina no encontrada
      </h1>
      <p className="mt-2 text-[14px] text-slate-500 text-center max-w-sm">
        La pagina que buscas no existe o ha sido movida.
      </p>

      <Link
        href="/login"
        className="mt-8 rounded-xl bg-blue-600 px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700"
      >
        Volver al inicio
      </Link>
    </div>
  );
}
