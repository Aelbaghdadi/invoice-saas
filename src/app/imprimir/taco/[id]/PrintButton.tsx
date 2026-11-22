"use client";

import { Printer } from "lucide-react";

/** «Imprimir»: abre el diálogo de impresión del navegador. No sale en el papel. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-blue-700 print:hidden"
    >
      <Printer className="h-4 w-4" />
      Imprimir
    </button>
  );
}
