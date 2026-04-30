import { LoginForm } from "./LoginForm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Receipt, CheckCircle2, FileText, Sparkles } from "lucide-react";

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
      {/* ── Left panel: hero CSS-only — fondo oscuro con mockup de producto ── */}
      <div
        className="hidden w-1/2 lg:flex relative overflow-hidden"
        style={{
          background:
            "radial-gradient(120% 80% at 0% 0%, #1e293b 0%, #0f172a 45%, #020617 100%)",
        }}
      >
        {/* Patron de rejilla sutil — da textura sin distraer. */}
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 30% 40%, black 30%, transparent 75%)",
          }}
        />

        {/* Glows de color para profundidad. */}
        <div className="absolute -top-32 -left-20 h-96 w-96 rounded-full bg-blue-500/20 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[28rem] w-[28rem] rounded-full bg-indigo-500/20 blur-[140px]" />
        <div className="absolute top-1/3 right-1/4 h-64 w-64 rounded-full bg-violet-500/15 blur-[100px]" />

        {/* Logo flotando arriba a la izquierda. */}
        <div className="absolute top-10 left-12 z-20 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 shadow-lg shadow-blue-900/50">
            <Receipt className="h-4.5 w-4.5 text-white" />
          </div>
          <span className="text-[17px] font-bold text-white">FacturOCR</span>
        </div>

        {/* Contenido principal: headline arriba + mockup debajo. Reducimos
            pt-24 -> pt-20 y pb-12 -> pb-10 para subir ligeramente el bloque
            y dar mas peso visual al mockup. */}
        <div className="relative z-10 flex w-full flex-col justify-center px-14 pt-20 pb-10">
          {/* Eyebrow — pill discreta sobre el titular. */}
          <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 backdrop-blur-sm">
            <Sparkles className="h-3 w-3 text-blue-300" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-300">
              OCR + IA para asesorías
            </span>
          </div>

          <h2 className="mt-5 text-[42px] font-extrabold leading-[1.05] tracking-tight text-white">
            Menos teclear.<br />
            <span className="bg-gradient-to-r from-blue-300 via-indigo-300 to-violet-300 bg-clip-text text-transparent">
              Más asesorar.
            </span>
          </h2>
          <p className="mt-4 max-w-md text-[14px] leading-relaxed text-slate-400">
            Automatiza la entrada de facturas, valida los datos en segundos
            y exporta directamente a A3 Asesor.
          </p>

          {/* ── Mockup del producto: ventana flotante con datos reales ── */}
          <div className="relative mt-8">
            {/* Glow detras del mockup. */}
            <div
              aria-hidden
              className="absolute -inset-8 rounded-[32px] bg-gradient-to-tr from-blue-500/30 via-indigo-500/20 to-transparent blur-2xl"
            />

            {/* Ventana principal — chrome + fila de factura desglosada. */}
            <div className="relative rounded-2xl border border-white/10 bg-slate-900/70 shadow-2xl shadow-black/50 backdrop-blur-sm">
              {/* Chrome de ventana. */}
              <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
                </div>
                <div className="ml-3 flex-1 rounded-md bg-white/5 px-2.5 py-1 text-[10px] text-slate-400">
                  facturocr.app/dashboard/worker/review
                </div>
              </div>

              {/* Cabecera del archivo en revision. */}
              <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/20 ring-1 ring-blue-400/30">
                    <FileText className="h-4 w-4 text-blue-300" />
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-white">mercadona-multi-iva.pdf</p>
                    <p className="text-[10px] text-slate-500">Mercadona S.A. · A46103834</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 ring-1 ring-emerald-400/30">
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  <span className="text-[10px] font-medium text-emerald-300">Validado</span>
                </div>
              </div>

              {/* Desglose de IVA — 3 lineas como en el producto real. */}
              <div className="px-5 py-4">
                <div className="mb-2.5 grid grid-cols-[1fr_60px_1fr] gap-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
                  <span>Base</span>
                  <span>% IVA</span>
                  <span>Cuota</span>
                </div>
                {[
                  { base: "58,52", rate: "4",  cuota: "2,34"  },
                  { base: "73,30", rate: "10", cuota: "7,33"  },
                  { base: "69,00", rate: "21", cuota: "14,49" },
                ].map((r, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_60px_1fr] items-center gap-3 rounded-md py-1.5 text-[12px] text-slate-200"
                  >
                    <span className="font-mono">{r.base} €</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] text-slate-300">
                      {r.rate}%
                    </span>
                    <span className="font-mono">{r.cuota} €</span>
                  </div>
                ))}
                <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Total</span>
                  <span className="text-[14px] font-bold text-white">224,98 €</span>
                </div>
              </div>
            </div>

            {/* Tarjeta flotante: anotacion AI a la derecha. */}
            <div className="absolute -right-4 top-20 hidden xl:block">
              <div className="rounded-xl border border-white/10 bg-slate-800/90 px-3 py-2 shadow-xl shadow-black/50 backdrop-blur-sm">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 text-blue-300" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-300">
                    Extraccion OCR
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-slate-300">3 tipos detectados</p>
                <p className="font-mono text-[10px] text-slate-500">98,4% confianza</p>
              </div>
            </div>
          </div>

          {/* Marcas / formatos — linea discreta de credibilidad. */}
          <div className="mt-10 flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">
              Exporta a
            </span>
            <span className="text-[14px] font-semibold text-slate-200">
              A3 Asesor
            </span>
            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[10px] font-semibold text-blue-300 ring-1 ring-blue-400/30">
              Excel listo para importar
            </span>
          </div>
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 shadow-md shadow-blue-200">
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

          {/* Linea de confianza tras el CTA. Sutil, refuerza valor sin
              competir con el formulario. */}
          <div className="mt-7 flex items-center justify-center gap-2 text-[11px] text-slate-400">
            <span>OCR inteligente</span>
            <span className="text-slate-300">·</span>
            <span>Validación manual</span>
            <span className="text-slate-300">·</span>
            <span>Exportación contable</span>
          </div>
          <p className="mt-2 text-center text-[11px] text-slate-400">
            Plataforma segura para asesorías y gestores.
          </p>
        </div>
      </div>
    </div>
  );
}
