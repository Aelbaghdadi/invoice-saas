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
        { href: "/dashboard/admin/batch",   label: "Lotes",           icon: Layers },
        { href: "/dashboard/admin/export",  label: "Exportar",        icon: Download },
      ],
    },
    {
      label: "Otros",
      items: [
        { href: "/dashboard/admin/clients",  label: "Clientes",  icon: Building2 },
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
};

const BATCH_LINKS: Record<Role, { href: string; label: string }> = {
  ADMIN:  { href: "/dashboard/worker/upload", label: "Nuevo lote" },
  WORKER: { href: "/dashboard/worker/upload", label: "Nuevo lote" },
  CLIENT: { href: "/dashboard/client/upload", label: "Subir facturas" },
};

const STORAGE_KEY = "facturocr.sidebar.openSections";

export function Sidebar({ role, userName }: SidebarProps) {
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
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
            active
              ? "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/20"
              : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900"
          }`}
        >
          <Icon className={`h-[18px] w-[18px] flex-shrink-0 ${active ? "text-white" : "text-slate-400"}`} />
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <aside className="flex h-full w-56 flex-col border-r border-slate-200/80 bg-gradient-to-b from-white to-slate-50/80">
      {/* Logo */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-500/30">
          <span className="text-[11px] font-bold tracking-wide">OCR</span>
        </div>
        <div>
          <p className="text-[13.5px] font-bold text-slate-900">FacturOCR</p>
          <p className="text-[10px] text-slate-400">Portal de asesoría</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, idx) => {
          // Sin label -> lista plana (sin cabecera ni desplegable).
          if (!section.label) {
            return (
              <ul key={idx} className="space-y-0.5">
                {section.items.map(renderItem)}
              </ul>
            );
          }
          const isOpen = openSections.has(section.label);
          return (
            <div key={section.label} className={idx > 0 ? "mt-3" : ""}>
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

      {/* Bottom actions */}
      <div className="border-t border-slate-100 p-3 space-y-1.5">
        {/* User section */}
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-2 mb-2">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 text-[11px] font-bold text-orange-600 ring-2 ring-white shadow-sm">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold text-slate-800">{userName}</p>
            <p className="text-[10px] text-slate-400 capitalize">{role.toLowerCase()}</p>
          </div>
        </div>

        <Link
          href={batchLink.href}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm shadow-blue-500/25 transition-all duration-200 hover:from-blue-700 hover:to-blue-600 hover:shadow-md hover:shadow-blue-500/30"
        >
          <Upload className="h-4 w-4" />
          {batchLink.label}
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 text-[12px] font-medium text-slate-400 transition-all duration-200 hover:bg-slate-100/70 hover:text-slate-600"
        >
          <LogOut className="h-3.5 w-3.5" />
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
