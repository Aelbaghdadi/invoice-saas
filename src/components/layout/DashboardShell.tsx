"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { LegalDisclaimer } from "./LegalDisclaimer";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Role } from "@prisma/client";
import { ToastProvider } from "@/components/ui/Toast";

type Props = {
  role: Role;
  userName: string;
  userEmail?: string | null;
  /** Marca de la asesoría para la barra lateral (arriba a la izquierda). */
  firmName?: string | null;
  firmLogo?: string | null;
  children: React.ReactNode;
};

const COLLAPSED_KEY = "facturocr.sidebar.collapsed";

export function DashboardShell({ role, userName, userEmail, firmName, firmLogo, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Modo "solo iconos" — persistido en localStorage. Solo aplica en
  // desktop; en movil el sidebar siempre se abre completo como overlay.
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLLAPSED_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Close sidebar on route change (syncing with router — legitimate external system)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with external router state
    setSidebarOpen(false);
  }, [pathname]);

  // Teclado: Escape cierra el overlay movil. Ctrl/Cmd+B colapsa el
  // sidebar — atajo estandar en SaaS (VSCode, Linear, Notion).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        // Ignorar si el foco esta en un input/textarea editable —
        // Ctrl+B nativo es "negrita" en algunos editores.
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
        e.preventDefault();
        toggleCollapsed();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <ToastProvider>
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Wrapper del sidebar. Anchura controlada aqui (el componente
          interno solo decide su layout segun `collapsed`). El toggle
          vive como una "pestania" en el borde derecho, estilo Linear. */}
      <div className={`
        group relative
        fixed inset-y-0 left-0 z-50 w-56 transition-[transform,width] duration-200 ease-out
        lg:static lg:translate-x-0
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        ${collapsed ? "lg:w-16" : "lg:w-56"}
      `}>
        {/* Mobile close button */}
        <button
          onClick={() => setSidebarOpen(false)}
          className="absolute right-2 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          aria-label="Cerrar menu"
        >
          <X className="h-5 w-5" />
        </button>

        <Sidebar role={role} userName={userName} userEmail={userEmail} firmName={firmName} firmLogo={firmLogo} collapsed={collapsed} />

        {/* Edge toggle (desktop). Aparece "encajado" sobre el borde
            derecho del sidebar, centrado verticalmente. Sutilmente
            visible siempre, mas marcado en hover. Atajo: Ctrl+B. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expandir barra lateral (Ctrl+B)" : "Plegar barra lateral (Ctrl+B)"}
          aria-label={collapsed ? "Expandir barra lateral" : "Plegar barra lateral"}
          className="
            hidden lg:flex absolute top-1/2 -right-3 z-20 -translate-y-1/2
            h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white
            text-slate-400 shadow-sm
            opacity-0 group-hover:opacity-100 transition-opacity duration-150
            hover:text-slate-700 hover:border-slate-300
          "
        >
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5" />
            : <ChevronLeft  className="h-3.5 w-3.5" />
          }
        </button>
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar userName={userName} onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/50 p-4 sm:p-6 shadow-[inset_0_2px_8px_0_rgba(15,23,42,0.04)]">
          {/* Contener el ancho en pantallas muy grandes: el contenido no se
              estira sin límite (sensación de vacío) sino que queda compuesto. */}
          <div className="mx-auto w-full max-w-[1600px]">
            {children}
          </div>
        </main>
        <LegalDisclaimer />
      </div>
    </div>
    </ToastProvider>
  );
}
