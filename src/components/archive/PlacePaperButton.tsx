"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { PlacePaperDialog, type PlacePaperTarget } from "./PlacePaperDialog";

/**
 * Botón que abre «Poner ubicación» (o «Sacar del taco») sobre lo que se le
 * pasa: una factura de la ficha o todo lo sin ubicación del ejercicio.
 */
export function PlacePaperButton({
  target,
  clientId,
  fiscalYear,
  label,
  variant = "secondary",
}: {
  target: PlacePaperTarget;
  clientId: string;
  /** Año en que empieza el ejercicio. */
  fiscalYear: number;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const className = variant === "primary"
    ? "inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700"
    : "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <MapPin className={`h-4 w-4 ${variant === "primary" ? "" : "text-slate-400"}`} />
        {label}
      </button>
      {open && <PlacePaperDialog target={target} clientId={clientId} fiscalYear={fiscalYear} onClose={() => setOpen(false)} />}
    </>
  );
}
