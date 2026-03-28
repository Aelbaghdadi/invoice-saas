import { LoginForm } from "./LoginForm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  Receipt,
  ScanLine,
  ShieldCheck,
  FileOutput,
  Clock,
  CheckCircle2,
  TrendingUp,
} from "lucide-react";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) {
    const role = session.user.role;
    if (role === "ADMIN") redirect("/dashboard/admin");
    if (role === "WORKER") redirect("/dashboard/worker");
    if (role === "CLIENT") redirect("/dashboard/client");
  }

  return (
    <div className="flex min-h-screen bg-white">
      {/* ── Left panel ── */}
      <div className="hidden w-1/2 flex-col bg-slate-900 p-12 lg:flex">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
            <Receipt className="h-4 w-4 text-white" />
          </div>
          <span className="text-[15px] font-semibold text-white">FacturOCR</span>
        </div>

        {/* Hero copy */}
        <div className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">
            Para asesorías contables
          </p>
          <h2 className="mt-3 text-3xl font-bold leading-tight text-white">
            De la factura al asiento<br />en menos de 2 minutos.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-400">
            Extrae, valida y exporta datos de facturas con OCR e inteligencia
            artificial. Sin errores manuales, sin perder tiempo.
          </p>
        </div>

        {/* Feature list */}
        <div className="mt-10 space-y-4">
          {[
            {
              icon: ScanLine,
              color: "text-blue-400",
              bg: "bg-blue-900/40",
              title: "OCR + IA de alta precisión",
              desc: "Extrae CIF, fecha, base, IVA e IRPF automáticamente.",
            },
            {
              icon: ShieldCheck,
              color: "text-emerald-400",
              bg: "bg-emerald-900/40",
              title: "Validación matemática instantánea",
              desc: "Detecta errores antes de que lleguen a la contabilidad.",
            },
            {
              icon: FileOutput,
              color: "text-violet-400",
              bg: "bg-violet-900/40",
              title: "Exportación con un clic",
              desc: "CSV listo para importar en Sage, Contasol, a3 y más.",
            },
          ].map(({ icon: Icon, color, bg, title, desc }) => (
            <div key={title} className="flex items-start gap-3.5">
              <div className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-200">{title}</p>
                <p className="mt-0.5 text-[12px] text-slate-500">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Stats */}
        <div className="mt-10 grid grid-cols-3 gap-4 border-t border-slate-800 pt-8">
          {[
            { icon: Clock,        color: "text-blue-400",   value: "< 2 min",  label: "Por factura" },
            { icon: TrendingUp,   color: "text-emerald-400",value: "+99%",     label: "Precisión OCR" },
            { icon: CheckCircle2, color: "text-violet-400", value: "0 €",      label: "Para empezar" },
          ].map(({ icon: Icon, color, value, label }) => (
            <div key={label} className="rounded-xl bg-slate-800/60 px-4 py-3">
              <Icon className={`mb-2 h-4 w-4 ${color}`} />
              <p className="text-xl font-bold text-white">{value}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{label}</p>
            </div>
          ))}
        </div>

        {/* Testimonial */}
        <div className="mt-8 rounded-xl border border-slate-800 bg-slate-800/40 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-[12px] font-bold text-white">
              ML
            </div>
            <div>
              <p className="text-[13px] font-semibold text-slate-200">María López</p>
              <p className="text-[11px] text-slate-500">Socia · Asesoría López & Asociados</p>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-slate-400">
            "Lo que antes tardábamos días ahora lo resolvemos en horas.
            FacturOCR es indispensable en nuestra asesoría."
          </p>
          <div className="mt-2 flex gap-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <svg key={i} className="h-3.5 w-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
              <Receipt className="h-4 w-4 text-white" />
            </div>
            <span className="text-[15px] font-semibold text-slate-900">FacturOCR</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Bienvenido de nuevo
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Introduce tus credenciales para acceder.
          </p>

          <div className="mt-8">
            <LoginForm />
          </div>
        </div>
      </div>
    </div>
  );
}
