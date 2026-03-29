export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl bg-slate-200/60 ${className}`}
    />
  );
}

export function CardSkeleton() {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-2xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-16" />
        </div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white">
      <div className="border-b border-slate-100 px-5 py-4">
        <Skeleton className="h-5 w-40" />
      </div>
      <div className="divide-y divide-slate-50">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="animate-fade-in-up space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-9 w-28 rounded-xl" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>

      {/* Table */}
      <TableSkeleton />
    </div>
  );
}

export function ListSkeleton() {
  return (
    <div className="animate-fade-in-up space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-9 w-28 rounded-xl" />
      </div>
      <TableSkeleton rows={6} />
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="animate-fade-in-up space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-5" />
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="space-y-4 rounded-2xl border border-slate-100 bg-white p-6">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}
