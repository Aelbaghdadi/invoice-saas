"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { Role } from "@prisma/client";
import {
  LayoutDashboard,
  Building2,
  Users,
  FileText,
  Layers,
  ClipboardList,
  Download,
  Settings,
  Upload,
  LogOut,
  CalendarCheck,
  ChevronDown,
  Inbox,
  Boxes,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
};

type NavSection = {
  /** Etiqueta del grupo. Si null/undefined, se renderiza sin cabecera ni
   *  desplegable (los items van al "tronco" del sidebar). */
  label?: string;
  items: NavItem[];
};

/**
 * Estructura del sidebar agrupada en secciones.
 *
 * Para ADMIN aplicamos la organización propuesta en el doc:
 *  - "Diario" → flujo de trabajo del día a día
 *  - "Otros"  → configuración y consultas puntuales
 *
 * "Incidencias" se quita: las incidencias ya aparecen pegadas a cada
 * factura en revisión, mantener un apartado aparte es ruido mental.
 */
const NAV_SECTIONS: Record<Role, NavSection[]> = {
  ADMIN: [
    {
      label: "Diario",
      items: [
        { href: "/dashboard/admin",         label: "Panel",           icon: LayoutDashboard },
        { href: "/dashboard/worker/upload", label: "Subir facturas",  icon: Upload },
        { href: "/dashboard/worker/clasificar", label: "Por clasificar", icon: Inbox },
        { href: "/dashboard/admin/batch",   label: "Lotes",           icon: Layers },
        { href: "/dashboard/admin/export",  label: "Exportar",        icon: Download },
      ],
    },
    {
      label: "Otros",
      items: [
        { href: "/dashboard/admin/clients",  label: "Clientes",  icon: Building2 },
        { href: "/dashboard/worker/groups",  label: "Grupos",    icon: Boxes },
        { href: "/dashboard/admin/workers",  label: "Gestores",  icon: Users },
        { href: "/dashboard/admin/invoices", label: "Facturas",  icon: FileText },
        { href: "/dashboard/admin/closures", label: "Cierres",   icon: CalendarCheck },
        { href: "/dashboard/admin/audit",    label: "Auditoría", icon: ClipboardList },
        { href: "/dashboard/admin/settings", label: "Ajustes",   icon: Settings },
      ],
    },
  ],
  // Worker: lista plana sin secciones (pocos items, no compensa agrupar).
  // Tambien le quitamos "Incidencias" por consistencia con admin.
  WORKER: [
    {
      items: [
        { href: "/dashboard/worker",          label: "Panel",          icon: LayoutDashboard },
        { href: "/dashboard/worker/clients",  label: "Clientes",       icon: Building2 },
        { href: "/dashboard/worker/invoices", label: "Facturas",       icon: FileText },
        { href: "/dashboard/worker/upload",   label: "Subir facturas", icon: Upload },
        { href: "/dashboard/worker/clasificar", label: "Por clasificar", icon: Inbox },
        { href: "/dashboard/worker/groups",   label: "Grupos",         icon: Boxes },
        { href: "/dashboard/worker/batch",    label: "Lotes",          icon: Layers },
      ],
    },
  ],
  CLIENT: [
    {
      items: [
        { href: "/dashboard/client",          label: "Panel",          icon: LayoutDashboard },
        { href: "/dashboard/client/invoices", label: "Mis facturas",   icon: FileText },
        { href: "/dashboard/client/upload",   label: "Subir facturas", icon: Layers },
      ],
    },
  ],
};

const ROOTS: Record<Role, string> = {
  ADMIN: "/dashboard/admin",
  WORKER: "/dashboard/worker",
  CLIENT: "/dashboard/client",
};

type SidebarProps = {
  role: Role;
  userName: string;
  userEmail?: string | null;
  /** Marca de la asesoría (configurable en Ajustes). Si hay logo se muestra
   *  arriba a la izquierda; si no, la marca por defecto (Faktury). */
  firmName?: string | null;
  firmLogo?: string | null;
  /** Modo "solo iconos" en desktop. Controlado por DashboardShell, que
   *  tambien renderiza el boton de toggle como pestania en el borde. */
  collapsed?: boolean;
};

const BATCH_LINKS: Record<Role, { href: string; label: string }> = {
  ADMIN:  { href: "/dashboard/worker/upload", label: "Nuevo lote" },
  WORKER: { href: "/dashboard/worker/upload", label: "Nuevo lote" },
  CLIENT: { href: "/dashboard/client/upload", label: "Subir facturas" },
};

/** Rol en formato legible (no exponemos el valor del enum en la UI). */
const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrador",
  WORKER: "Gestor",
  CLIENT: "Cliente",
};

const STORAGE_KEY = "facturocr.sidebar.openSections";

export function Sidebar({ role, userName, firmName, firmLogo, collapsed = false }: SidebarProps) {
  const pathname = usePathname();
  const sections = NAV_SECTIONS[role];
  const batchLink = BATCH_LINKS[role];

  // Estado de secciones abiertas, persistido en localStorage. Por defecto
  // solo "Diario" abierto: "Otros" se pliega para reducir ruido visual,
  // el usuario lo abre si lo necesita y se queda guardado.
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    return new Set(
      sections.filter((s) => s.label && s.label !== "Otros").map((s) => s.label!),
    );
  });

  // Hidratar desde localStorage tras el mount (evitar mismatch SSR).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) setOpenSections(new Set(arr));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleSection = (label: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const isActive = (href: string) => {
    if (href === ROOTS[role]) return pathname === href;
    return pathname.startsWith(href);
  };

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const renderItem = (item: NavItem) => {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          title={collapsed ? item.label : undefined}
          className={`relative flex items-center rounded-lg text-[13px] transition-colors duration-150 ${
            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2"
          } ${
            active
              ? "bg-blue-50 font-semibold text-blue-800"
              : "font-medium text-slate-600 hover:bg-slate-100/70 hover:text-slate-900"
          }`}
        >
          {/* Indicador de activo: línea turquesa fina, firma de la marca. */}
          {active && !collapsed && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-500" />
          )}
          <Icon className={`h-[18px] w-[18px] flex-shrink-0 ${active ? "text-blue-700" : "text-slate-400"}`} strokeWidth={1.8} />
          {!collapsed && item.label}
        </Link>
      </li>
    );
  };

  return (
    <aside className="flex h-full w-full flex-col border-r border-slate-200/80 bg-white">
      {/* Logo. Altura alineada con la Topbar (h-14) para que quede una
          linea horizontal continua entre las dos zonas.
          El toggle plegar/expandir vive como pestania en el borde
          derecho (renderizado por DashboardShell) + atajo Ctrl+B. */}
      <div className={`flex h-14 flex-shrink-0 items-center border-b border-slate-200/70 ${
        collapsed ? "justify-center px-2" : "gap-2.5 px-4"
      }`}>
        {firmLogo ? (
          // Logo de la asesoría configurado en Ajustes. object-contain para que
          // entre cualquier proporción dentro de la altura de la cabecera.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={firmLogo}
            alt={firmName ?? "Logo"}
            className={collapsed ? "h-7 w-7 object-contain" : "h-8 max-w-[160px] object-contain"}
          />
        ) : (
          <>
            {/* Marca por defecto: isotipo real de Faktury (SVG, nítido a
                cualquier tamaño), nada de chips de texto. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/faktury-icon.svg"
              alt="Faktury"
              className={collapsed ? "h-7 w-7 flex-shrink-0" : "h-8 w-8 flex-shrink-0"}
            />
            {!collapsed && (
              <p className="text-[14px] font-semibold text-slate-800 tracking-tight">
                Faktury
              </p>
            )}
          </>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-4">
        {sections.map((section, idx) => {
          // Sin label -> lista plana (sin cabecera ni desplegable).
          if (!section.label) {
            return (
              <ul key={idx} className="space-y-0.5">
                {section.items.map(renderItem)}
              </ul>
            );
          }
          // En modo colapsado no hay sentido a las cabeceras "Diario" /
          // "Otros": ocupan sitio y sin texto al lado no aportan. Las
          // sustituimos por un separador y mostramos todos los items.
          if (collapsed) {
            return (
              <div key={section.label} className={idx > 0 ? "mt-2 pt-2 border-t border-slate-100" : ""}>
                <ul className="space-y-0.5">
                  {section.items.map(renderItem)}
                </ul>
              </div>
            );
          }
          const isOpen = openSections.has(section.label);
          return (
            <div key={section.label} className={idx > 0 ? "mt-4" : ""}>
              <button
                type="button"
                onClick={() => toggleSection(section.label!)}
                className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:text-slate-600"
              >
                {section.label}
                <ChevronDown
                  className={`h-3 w-3 transition-transform duration-200 ${isOpen ? "rotate-0" : "-rotate-90"}`}
                />
              </button>
              {isOpen && (
                <ul className="mt-0.5 space-y-0.5">
                  {section.items.map(renderItem)}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      {/* Bottom actions — en colapsado: solo iconos centrados. */}
      <div className={`border-t border-slate-100 ${collapsed ? "px-2 py-2 space-y-1" : "p-3 space-y-1.5"}`}>
        {/* User section — panel suave para que se lea como "centro de cuenta" */}
        <div className={`flex items-center ${collapsed ? "justify-center py-1.5" : "gap-2.5 rounded-lg bg-slate-50/80 px-2.5 py-2 mb-2"}`}>
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-bold text-blue-700">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-slate-800">{userName}</p>
              <p className="text-[10px] text-slate-500">{ROLE_LABELS[role]}</p>
            </div>
          )}
        </div>

        <Link
          href={batchLink.href}
          title={collapsed ? batchLink.label : undefined}
          className={`flex w-full items-center justify-center rounded-lg bg-blue-600 text-[13px] font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-blue-700 ${
            collapsed ? "px-2 py-2.5" : "gap-2 px-4 py-2.5"
          }`}
        >
          <Upload className="h-4 w-4" strokeWidth={1.8} />
          {!collapsed && batchLink.label}
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          title={collapsed ? "Cerrar sesión" : undefined}
          className={`flex w-full items-center justify-center rounded-lg text-[12px] font-medium text-slate-400 transition-colors duration-150 hover:bg-slate-100/70 hover:text-slate-600 ${
            collapsed ? "px-2 py-2" : "gap-2 px-4 py-2"
          }`}
        >
          <LogOut className="h-3.5 w-3.5" />
          {!collapsed && "Cerrar sesión"}
        </button>

        {/* Co-branding discreto: el logo del tenant es el protagonista arriba;
            aquí abajo, una firma tenue del producto, integrada tras un
            separador fino. Solo texto: a este tamaño un isotipo no se lee. */}
        {!collapsed && (
          <p className="mt-1 border-t border-slate-100 pt-2 text-center text-[9px] font-medium uppercase tracking-[0.14em] text-slate-300">
            Powered by <span className="text-slate-400">Faktury</span>
          </p>
        )}
      </div>
    </aside>
  );
}
