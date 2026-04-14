"use client";

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
  AlertTriangle,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
};

const NAV_ITEMS: Record<Role, NavItem[]> = {
  ADMIN: [
    { href: "/dashboard/admin",          label: "Panel",             icon: LayoutDashboard },
    { href: "/dashboard/admin/clients",  label: "Clientes",          icon: Building2 },
    { href: "/dashboard/admin/workers",  label: "Gestores",          icon: Users },
    { href: "/dashboard/admin/invoices", label: "Facturas",          icon: FileText },
    { href: "/dashboard/admin/batch",    label: "Lotes",             icon: Layers },
    { href: "/dashboard/admin/export",   label: "Exportar",          icon: Download },
    { href: "/dashboard/admin/closures", label: "Cierres",           icon: CalendarCheck },
    { href: "/dashboard/admin/audit",     label: "Auditoría",         icon: ClipboardList },
    { href: "/dashboard/admin/settings", label: "Ajustes",           icon: Settings },
  ],
  WORKER: [
    { href: "/dashboard/worker", label: "Panel", icon: LayoutDashboard },
    { href: "/dashboard/worker/clients", label: "Clientes", icon: Building2 },
    { href: "/dashboard/worker/invoices", label: "Facturas", icon: FileText },
    { href: "/dashboard/worker/issues", label: "Incidencias", icon: AlertTriangle },
    { href: "/dashboard/worker/upload", label: "Subir facturas", icon: Upload },
    { href: "/dashboard/worker/batch", label: "Lotes", icon: Layers },
  ],
  CLIENT: [
    { href: "/dashboard/client", label: "Panel", icon: LayoutDashboard },
    { href: "/dashboard/client/invoices", label: "Mis facturas", icon: FileText },
    { href: "/dashboard/client/upload", label: "Subir facturas", icon: Layers },
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

export function Sidebar({ role, userName }: SidebarProps) {
  const pathname = usePathname();
  const navItems = NAV_ITEMS[role];
  const batchLink = BATCH_LINKS[role];

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
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
                    active
                      ? "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/20"
                      : "text-slate-600 hover:bg-slate-100/70 hover:text-slate-900 hover:scale-[1.01]"
                  }`}
                >
                  <Icon className={`h-[18px] w-[18px] flex-shrink-0 ${active ? "text-white" : "text-slate-400"}`} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
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
