"use client";

import { AlertCircle, RotateCcw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <div className="mb-4 rounded-full bg-red-100 p-4">
        <AlertCircle className="h-8 w-8 text-red-500" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-slate-800">Algo salió mal</h2>
      <p className="mb-6 max-w-md text-[13px] text-slate-500">
        Se ha producido un error inesperado. Si el problema persiste, contacta con soporte.
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-blue-700"
      >
        <RotateCcw className="h-4 w-4" />
        Reintentar
      </button>
      {error.digest && (
        <p className="mt-4 text-[11px] text-slate-300">Código: {error.digest}</p>
      )}
    </div>
  );
}
