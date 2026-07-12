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
  "/dashboard/admin":              "Panel de control",
  "/dashboard/admin/clients":      "Clientes",
  "/dashboard/admin/workers":      "Gestores",
  "/dashboard/admin/invoices":     "Facturas",
  "/dashboard/admin/closures":     "Cierres",
  "/dashboard/admin/audit":        "Auditoría",
  "/dashboard/admin/settings":     "Ajustes",
  "/dashboard/admin/batch":        "Lotes",
  "/dashboard/admin/export":       "Exportar",
  "/dashboard/worker":             "Panel de control",
  "/dashboard/worker/clients":     "Clientes",
  "/dashboard/worker/invoices":    "Facturas",
  "/dashboard/worker/upload":      "Subir facturas",
  "/dashboard/worker/batch":       "Lotes",
  "/dashboard/worker/issues":      "Incidencias",
  "/dashboard/worker/review":      "Revisión",
  "/dashboard/client":             "Panel de control",
  "/dashboard/client/invoices":    "Mis facturas",
  "/dashboard/client/upload":      "Subir facturas",
};

/** Subtítulo contextual — solo en las raíces (paneles), donde aporta. */
const ROUTE_SUBTITLES: Record<string, string> = {
  "/dashboard/admin":  "Resumen de facturas, validaciones y exportaciones contables",
  "/dashboard/worker": "Resumen de facturas, validaciones y exportaciones contables",
  "/dashboard/client": "Resumen de tus facturas y su estado",
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
  // Subtítulo solo en la raíz exacta del panel (no en subpáginas).
  const subtitle = ROUTE_SUBTITLES[pathname];

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Fecha del día como detalle de cabecera (sin lógica: solo informativo).
  const today = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <header className="relative z-30 flex h-14 flex-shrink-0 items-center justify-between border-b border-slate-200/70 bg-white px-3 shadow-[0_1px_3px_rgb(2_15_40_/_0.03)] sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only */}
        <button
          onClick={onMenuClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden"
          aria-label="Abrir menu"
        >
          <Menu className="h-4.5 w-4.5" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight text-slate-900">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-0.5 hidden truncate text-[11px] leading-tight text-slate-400 sm:block">
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {/* Fecha + avatar. El nombre completo vive solo en el bloque de
          perfil del sidebar (abajo-izquierda); aqui no lo repetimos. Sin
          dropdown — la sesion se cierra desde el sidebar. */}
      <div className="flex items-center gap-3">
        <span
          suppressHydrationWarning
          className="hidden text-[12px] capitalize text-slate-400 md:block"
        >
          {today}
        </span>
        <span className="hidden h-5 w-px bg-slate-200/80 md:block" />
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-[10px] font-bold text-white shadow-sm"
          title={userName}
        >
          {initials}
        </div>
      </div>
    </header>
  );
}
