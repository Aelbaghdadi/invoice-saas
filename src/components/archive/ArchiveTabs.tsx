import Link from "next/link";
import { Archive, Layers } from "lucide-react";

const TABS = [
  { key: "resumen", label: "Resumen", href: "/dashboard/archivo", icon: Archive },
  { key: "tacos", label: "Tacos", href: "/dashboard/archivo/tacos", icon: Layers },
] as const;

export type ArchiveTab = (typeof TABS)[number]["key"];

/** Las pestañas del archivo, bajo el título: el resumen y los tacos de papel. */
export function ArchiveTabs({ active }: { active: ArchiveTab }) {
  return (
    <nav aria-label="Secciones del archivo" className="-mt-2 mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
      {TABS.map((tab) => {
        const current = tab.key === active;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
              current ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon className="h-4 w-4" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
