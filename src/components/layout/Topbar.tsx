"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

type TopbarProps = {
  userName: string;
  onMenuClick?: () => void;
};

/**
 * Mapeo ruta → titulo legible. La cabecera muestra el segmento de mayor
 * granularidad que conocemos; los segmentos dinamicos ([id]) se reducen
 * a "Detalle" para no enseniar cuids al usuario.
 */
const ROUTE_LABELS: Record<string, string> = {
  "/dashboard/admin":              "Panel",
  "/dashboard/admin/clients":      "Clientes",
  "/dashboard/admin/workers":      "Gestores",
  "/dashboard/admin/invoices":     "Facturas",
  "/dashboard/admin/closures":     "Cierres",
  "/dashboard/admin/audit":        "Auditoría",
  "/dashboard/admin/settings":     "Ajustes",
  "/dashboard/admin/batch":        "Lotes",
  "/dashboard/admin/export":       "Exportar",
  "/dashboard/worker":             "Panel",
  "/dashboard/worker/clients":     "Clientes",
  "/dashboard/worker/invoices":    "Facturas",
  "/dashboard/worker/upload":      "Subir facturas",
  "/dashboard/worker/batch":       "Lotes",
  "/dashboard/worker/issues":      "Incidencias",
  "/dashboard/worker/review":      "Revisión",
  "/dashboard/client":             "Panel",
  "/dashboard/client/invoices":    "Mis facturas",
  "/dashboard/client/upload":      "Subir facturas",
};

function pageTitleFrom(pathname: string): string {
  // Probamos del path completo al mas corto (pega bien con detalle/edit).
  const segments = pathname.split("/").filter(Boolean);
  for (let i = segments.length; i > 0; i--) {
    const candidate = "/" + segments.slice(0, i).join("/");
    if (ROUTE_LABELS[candidate]) return ROUTE_LABELS[candidate];
  }
  return "Dashboard";
}

export function Topbar({ userName, onMenuClick }: TopbarProps) {
  const pathname = usePathname();
  const title = pageTitleFrom(pathname);

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="relative z-30 flex h-12 flex-shrink-0 items-center justify-between border-b border-slate-200/70 bg-white px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden"
          aria-label="Abrir menu"
        >
          <Menu className="h-4.5 w-4.5" />
        </button>
        <h1 className="truncate text-[13px] font-semibold text-slate-700">
          {title}
        </h1>
      </div>

      {/* Avatar del usuario. Sin dropdown — la sesion se cierra desde el
          sidebar (no duplicamos affordances). */}
      <div className="flex items-center gap-2">
        <span className="hidden text-[12px] text-slate-500 sm:inline">
          {userName}
        </span>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-[10px] font-bold text-white"
          title={userName}
        >
          {initials}
        </div>
      </div>
    </header>
  );
}
