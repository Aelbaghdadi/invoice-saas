"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { LegalDisclaimer } from "./LegalDisclaimer";
import { X } from "lucide-react";
import { Role } from "@prisma/client";
import { ToastProvider } from "@/components/ui/Toast";

type Props = {
  role: Role;
  userName: string;
  userEmail?: string | null;
  userRole: string;
  children: React.ReactNode;
};

export function DashboardShell({ role, userName, userEmail, userRole, children }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Close sidebar on route change (syncing with router — legitimate external system)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with external router state
    setSidebarOpen(false);
  }, [pathname]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
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

      {/* Sidebar — hidden on mobile, slide-in when open */}
      <div className={`
        fixed inset-y-0 left-0 z-50 w-56 transition-transform duration-300 ease-in-out lg:static lg:translate-x-0
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        {/* Mobile close button */}
        <button
          onClick={() => setSidebarOpen(false)}
          className="absolute right-2 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
        >
          <X className="h-5 w-5" />
        </button>
        <Sidebar role={role} userName={userName} userEmail={userEmail} />
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar
          userName={userName}
          userRole={userRole}
          role={role}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-slate-50/50 p-4 sm:p-6 shadow-[inset_0_2px_8px_0_rgba(15,23,42,0.04)]">
          {children}
        </main>
        <LegalDisclaimer />
      </div>
    </div>
    </ToastProvider>
  );
}
