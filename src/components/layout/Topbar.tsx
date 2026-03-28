"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Search, Bell, Settings, Building2, FileText, Loader2, X, Menu,
} from "lucide-react";

type TopbarProps = {
  userName: string;
  userRole: string;
  role: string;
  onMenuClick?: () => void;
};

type SearchResult = {
  type: "client" | "invoice";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

export function Topbar({ userName, userRole, role, onMenuClick }: TopbarProps) {
  const router = useRouter();
  const firstName = userName.split(" ")[0];
  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // ── Search state ──────────────────────────────────────────────────────
  const [query, setQuery]       = useState("");
  const [results, setResults]   = useState<SearchResult[]>([]);
  const [loading, setLoading]   = useState(false);
  const [open, setOpen]         = useState(false);
  const containerRef            = useRef<HTMLDivElement>(null);
  const debounceRef             = useRef<ReturnType<typeof setTimeout>>(undefined);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data.results ?? []);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleChange = (val: string) => {
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (val.length < 2) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(() => search(val), 250);
  };

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    setQuery("");
    router.push(result.href);
  };

  const handleClear = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keyboard shortcut: Ctrl+K / Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const input = containerRef.current?.querySelector("input");
        input?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const settingsHref = role === "ADMIN"
    ? "/dashboard/admin/settings"
    : role === "WORKER"
      ? "/dashboard/worker"
      : "/dashboard/client";

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200/60 bg-white/80 px-3 sm:px-6 backdrop-blur-xl">
      {/* Hamburger — mobile only */}
      <button
        onClick={onMenuClick}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden mr-2"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* ── Search ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 items-center px-0">
        <div ref={containerRef} className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => { if (results.length > 0) setOpen(true); }}
            placeholder="Buscar clientes, facturas..."
            className="w-full rounded-xl border border-slate-200 bg-slate-100/60 py-2 pl-9 pr-16 text-sm text-slate-700 placeholder-slate-400 outline-none transition-all duration-200 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 focus:max-w-lg"
          />
          {/* Right side indicators */}
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            {query && !loading && (
              <button onClick={handleClear} className="rounded p-0.5 text-slate-400 hover:text-slate-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {!query && (
              <kbd className="hidden rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:inline-block">
                Ctrl+K
              </kbd>
            )}
          </div>

          {/* ── Results dropdown ───────────────────────────────────────── */}
          {open && (
            <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-xl shadow-slate-200/50">
              {/* Arrow indicator */}
              <div className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-l border-t border-slate-200/80 bg-white" />
              {results.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-[13px] text-slate-400">
                    No se encontraron resultados para &quot;{query}&quot;
                  </p>
                </div>
              ) : (
                <ul className="max-h-80 overflow-y-auto py-1">
                  {results.map((r) => {
                    const Icon = r.type === "client" ? Building2 : FileText;
                    const iconBg = r.type === "client" ? "bg-blue-50 text-blue-600" : "bg-purple-50 text-purple-600";
                    return (
                      <li key={`${r.type}-${r.id}`}>
                        <button
                          type="button"
                          onClick={() => handleSelect(r)}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-all duration-150 hover:bg-blue-50/50"
                        >
                          <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-slate-800">
                              {r.title}
                            </p>
                            <p className="truncate text-[11px] text-slate-400">
                              {r.subtitle}
                            </p>
                          </div>
                          <span className="flex-shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                            {r.type === "client" ? "Cliente" : "Factura"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right actions ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 ml-4">
        <button
          className="relative rounded-lg p-2 text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-600"
          title="Notificaciones"
        >
          <Bell className="h-[18px] w-[18px]" />
        </button>
        <Link
          href={settingsHref}
          className="hidden sm:flex rounded-lg p-2 text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-600"
          title="Ajustes"
        >
          <Settings className="h-[18px] w-[18px]" />
        </Link>

        <div className="ml-2 hidden sm:flex items-center gap-2.5 border-l border-slate-200 pl-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-[11px] font-bold text-white ring-2 ring-white shadow-sm">
            {initials}
          </div>
        </div>
      </div>
    </header>
  );
}
