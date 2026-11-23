"use client";

import { Compass } from "lucide-react";
import { useTour } from "./TourProvider";

/** «Recorrido» en la barra de arriba: arranca la visita guiada por la app. */
export function TourButton() {
  const { available, active, start } = useTour();
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={start}
      disabled={active}
      title="Recorrido guiado por la app"
      className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] font-semibold text-slate-600 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50 sm:px-3"
    >
      <Compass className="h-4 w-4" strokeWidth={1.8} />
      <span className="hidden sm:inline">Recorrido</span>
    </button>
  );
}
