/**
 * Textos de los dos ajustes del papel de la asesoría (Ajustes → «Papel»).
 * Sin Prisma en tiempo de ejecución: lo usan Ajustes y la subida, también en
 * el navegador.
 */
import type { PaperBoxMode, PaperScanMode } from "@prisma/client";

export const PAPER_SCAN_MODES = ["PER_INVOICE", "WHOLE_PDF"] as const satisfies readonly PaperScanMode[];
export const PAPER_BOX_MODES = ["PER_CLIENT_YEAR", "SHARED"] as const satisfies readonly PaperBoxMode[];

export const PAPER_SCAN_MODE_LABELS: Record<PaperScanMode, { label: string; help: string }> = {
  PER_INVOICE: {
    label: "Factura a factura",
    help: "Un fichero por factura. Al subir, la app las ordena por nombre y numera las páginas del taco.",
  },
  WHOLE_PDF: {
    label: "El taco entero en un PDF",
    help: "Un solo PDF con todo el taco. Después se marca dónde empieza cada factura. La página que se apunta es la del PDF: en el papel se cuentan facturas, no hojas.",
  },
};

export const PAPER_BOX_MODE_LABELS: Record<PaperBoxMode, { label: string; help: string }> = {
  PER_CLIENT_YEAR: {
    label: "Una caja por cliente y año",
    help: "Se propone «Panadería López · 2026 · Caja 1».",
  },
  SHARED: {
    label: "Todas juntas",
    help: "Se propone la última caja que se usó en la asesoría, por ejemplo «Caja 12».",
  },
};
