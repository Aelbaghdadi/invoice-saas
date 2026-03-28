type BadgeVariant = "blue" | "yellow" | "green" | "slate" | "red" | "purple" | "orange";

const VARIANTS: Record<BadgeVariant, { badge: string; dot: string }> = {
  blue:   { badge: "bg-blue-50/80 text-blue-700 border border-blue-200/70",     dot: "bg-blue-500" },
  yellow: { badge: "bg-amber-50/80 text-amber-700 border border-amber-200/70",  dot: "bg-amber-400" },
  green:  { badge: "bg-emerald-50/80 text-emerald-700 border border-emerald-200/70", dot: "bg-emerald-500" },
  slate:  { badge: "bg-slate-100/80 text-slate-600 border border-slate-200/70", dot: "bg-slate-400" },
  red:    { badge: "bg-red-50/80 text-red-700 border border-red-200/70",        dot: "bg-red-500" },
  purple: { badge: "bg-violet-50/80 text-violet-700 border border-violet-200/70", dot: "bg-violet-500" },
  orange: { badge: "bg-orange-50/80 text-orange-700 border border-orange-200/70", dot: "bg-orange-500" },
};

export function Badge({
  children,
  variant = "slate",
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
}) {
  const { badge, dot } = VARIANTS[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide ${badge}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot} opacity-80`} />
      {children}
    </span>
  );
}
