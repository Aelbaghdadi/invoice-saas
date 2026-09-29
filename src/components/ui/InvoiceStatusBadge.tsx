import type { InvoiceStatus } from "@prisma/client";
import { Badge } from "@/components/ui/Badge";
import { STATUS_LABELS, STATUS_BADGE_VARIANT } from "@/lib/invoiceStatuses";

/**
 * Estado de una factura, igual en todas las listas: etiqueta, color y, si ya
 * salio en un Excel, la marca "Exportada" o "Por reexportar".
 *
 * Un estado desconocido sale en gris con su propio nombre, nunca como
 * "Subida" (que es lo que hacian las copias locales con `?? UPLOADED`).
 */
export function InvoiceStatusBadge({
  status,
  exported = false,
  pendingReexport = false,
}: {
  status: InvoiceStatus | string;
  /** Salio alguna vez en un Excel para A3. */
  exported?: boolean;
  /** Salio en un Excel y se corrigio despues: A3 tiene el dato viejo. */
  pendingReexport?: boolean;
}) {
  const label = STATUS_LABELS[status as InvoiceStatus] ?? status;
  const variant = STATUS_BADGE_VARIANT[status as InvoiceStatus] ?? "slate";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={variant}>{label}</Badge>
      {exported && (
        pendingReexport ? (
          <span
            className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
            title="Salió en un Excel y se corrigió después: A3 tiene el dato viejo hasta que se vuelva a exportar"
          >
            Por reexportar
          </span>
        ) : (
          <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
            Exportada
          </span>
        )
      )}
    </span>
  );
}
