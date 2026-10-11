import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { canUseSupport, pagePathFrom } from "@/lib/support";
import { NewTicketForm } from "./NewTicketForm";

export default async function NewSupportTicketPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canUseSupport(session.user.role)) redirect("/dashboard");

  // La pantalla desde la que se vino: contexto para reproducir un fallo. Se
  // guarda al crear el ticket (la accion la recibe en un campo oculto).
  const referer = (await headers()).get("referer");
  const fromPage = pagePathFrom(referer);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/dashboard/support" className="mb-4 flex items-center gap-1.5 text-[13px] text-slate-500 hover:text-slate-700">
        <ChevronLeft className="h-4 w-4" />
        Volver a soporte
      </Link>
      <PageHeader
        title="Nuevo ticket"
        description="Cuanto más concreto, antes lo resolvemos: qué hacías, qué esperabas y qué ha pasado. Una captura ayuda mucho."
      />
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <NewTicketForm pageUrl={fromPage && !fromPage.startsWith("/dashboard/support") ? fromPage : ""} />
      </div>
    </div>
  );
}
