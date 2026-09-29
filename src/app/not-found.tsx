import Link from "next/link";
import Image from "next/image";
import { BRAND } from "@/lib/brand";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <Image
        src="/brand/faktury-logo.svg"
        alt={BRAND}
        width={192}
        height={64}
        priority
        className="mb-8 h-16 w-auto"
      />

      <p className="text-7xl font-extrabold text-blue-600">404</p>
      <h1 className="mt-4 text-xl font-bold text-slate-800">
        Página no encontrada
      </h1>
      <p className="mt-2 text-[14px] text-slate-500 text-center max-w-sm">
        La página que buscas no existe o ha sido movida.
      </p>

      <Link
        href="/login"
        className="mt-8 rounded-lg bg-blue-600 px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-blue-700"
      >
        Volver al inicio
      </Link>
    </div>
  );
}
