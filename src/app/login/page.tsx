import { LoginForm } from "./LoginForm";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Image from "next/image";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) {
    const role = session.user.role;
    if (role === "ADMIN") redirect("/dashboard/admin");
    if (role === "WORKER") redirect("/dashboard/worker");
    if (role === "CLIENT") redirect("/dashboard/client");
  }

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-[#f5f2ea]">
      {/* Hero full-bleed (solo desktop). El tercio izquierdo de la foto
          esta vacio: ahi flota el form. El #f5f2ea del wrapper coincide
          con el off-white de la imagen, asi cuando el form se solapa
          parece parte de la misma composicion.
          quality={95} contrarresta la compresion default (75) y mejora
          legibilidad de la foto. El sizes pasa a Next el ancho real
          (viewport - 440px del form) para que sirva la version optima. */}
      <Image
        src="/hero/login.png"
        alt=""
        fill
        priority
        quality={95}
        sizes="(min-width: 1024px) calc(100vw - 440px), 100vw"
        className="hidden lg:block object-cover object-center"
      />

      {/* Form column. Ancho fijo (~440px) en lugar de w-1/2 para que el
          form quede acompaniado y no perdido en un mar vacio. La foto
          ocupa el resto del viewport. */}
      <div className="relative z-10 flex w-full lg:w-[440px] lg:flex-shrink-0 items-center justify-center px-6 py-10 sm:px-10 lg:px-12">
        <div className="w-full max-w-sm">
          {/* Brand — logo horizontal de Faktury (isotipo + wordmark), con
              presencia: ocupa buena parte del ancho del formulario. Alineado
              a la izquierda, pegado al borde del bloque como el resto. */}
          {/* -ml-6 compensa el lienzo vacío a la izquierda del SVG (~9%)
              para que el isotipo quede alineado con los campos del form. */}
          <div className="mb-8 -ml-6">
            <Image
              src="/brand/faktury-logo.svg"
              alt="Faktury"
              width={288}
              height={96}
              priority
              className="h-24 w-auto"
            />
          </div>

          <h1 className="text-[26px] font-bold tracking-tight text-slate-900">
            Bienvenido de nuevo
          </h1>
          <p className="mt-2 text-[14px] text-slate-500">
            Introduce tus credenciales para acceder.
          </p>

          <div className="mt-8">
            <LoginForm />
          </div>

          {/* Linea de confianza tras el CTA. */}
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
