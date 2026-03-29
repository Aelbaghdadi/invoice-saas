import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div className="flex h-[calc(100vh-64px)] animate-fade-in-up">
      {/* Left - PDF viewer skeleton */}
      <div className="flex w-[55%] flex-col bg-[#1e1e2e]">
        <div className="flex items-center gap-3 border-b border-white/10 bg-[#16161f] px-4 py-2.5">
          <Skeleton className="h-7 w-7 rounded-lg bg-white/10" />
          <Skeleton className="h-3 w-24 bg-white/10" />
          <Skeleton className="ml-auto h-7 w-7 rounded-lg bg-white/10" />
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Skeleton className="h-[70%] w-[60%] rounded-lg bg-white/5" />
        </div>
      </div>
      {/* Right - Form skeleton */}
      <div className="flex w-[45%] flex-col border-l border-slate-200 bg-white p-6">
        <Skeleton className="mb-4 h-8 w-48" />
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      </div>
    </div>
  );
}
