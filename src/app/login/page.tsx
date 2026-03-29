import { LoginForm } from "./LoginForm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Receipt } from "lucide-react";

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
      <div className="hidden w-1/2 flex-col justify-center lg:flex relative overflow-hidden"
           style={{ background: "linear-gradient(135deg, #eff6ff 0%, #e0eafc 40%, #ddd6fe 100%)" }}>
        {/* Decorative blurred circles */}
        <div className="absolute -top-20 -left-20 h-72 w-72 rounded-full bg-blue-300/30 blur-3xl" />
        <div className="absolute bottom-10 right-10 h-60 w-60 rounded-full bg-violet-300/25 blur-3xl" />
        <div className="absolute top-1/2 left-1/3 h-40 w-40 rounded-full bg-blue-200/30 blur-2xl" />

        {/* Fixed logo top-left */}
        <div className="absolute top-10 left-12 z-10 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 shadow-md shadow-blue-200">
            <Receipt className="h-4.5 w-4.5 text-white" />
          </div>
          <span className="text-[17px] font-bold text-slate-800">FacturOCR</span>
        </div>

        <div className="relative z-10 px-12">
          {/* Headline */}
          <h2 className="text-4xl font-extrabold leading-tight text-slate-800">
            Creado para la<br />
            nueva era de la{" "}
            <span className="text-blue-600">contabilidad.</span>
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-slate-500">
            Automatiza la gestion de facturas de tu asesoria con OCR
            e inteligencia artificial. Sin errores manuales, sin perder tiempo.
          </p>

          {/* Feature pills */}
          <div className="mt-8 flex flex-wrap gap-2.5">
            {[
              "OCR con IA",
              "Validacion automatica",
              "Exportacion CSV",
              "Multi-cliente",
              "Auditorias",
            ].map((f) => (
              <span
                key={f}
                className="rounded-full border border-blue-200/60 bg-white/60 px-4 py-1.5 text-[12px] font-medium text-slate-600 backdrop-blur-sm shadow-sm"
              >
                {f}
              </span>
            ))}
          </div>

          {/* Stats */}
          <div className="mt-10 grid grid-cols-3 gap-4">
            {[
              { value: "< 2 min", label: "Por factura" },
              { value: "99.5%",   label: "Precision OCR" },
              { value: "0 \u20AC",       label: "Para empezar" },
            ].map(({ value, label }) => (
              <div key={label} className="rounded-xl bg-white/50 px-4 py-3.5 backdrop-blur-sm border border-white/60 shadow-sm">
                <p className="text-xl font-bold text-slate-800">{value}</p>
                <p className="mt-0.5 text-[11px] font-medium text-slate-400">{label}</p>
              </div>
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

          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
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
