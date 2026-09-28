import Link from "next/link";
import { BATCH_WINDOW_MONTHS } from "@/lib/batchGroups";

/**
 * Qué parte del histórico se ve en Lotes (F-030): por defecto, los últimos
 * meses y los lotes anteriores con algo pendiente; con un enlace para ver el
 * resto. Con un año elegido en los filtros no hay ventana y no sale.
 */
export function BatchWindowNote({ showHistory, toggleHref }: { showHistory: boolean; toggleHref: string }) {
  return (
    <p className="mb-4 text-[12px] text-slate-500">
      {showHistory
        ? "Se ve todo el histórico. "
        : `Se ven los últimos ${BATCH_WINDOW_MONTHS} meses y, de antes, los lotes que aún tienen algo pendiente. `}
      {/* Sin precarga: el histórico entero es justo lo que se quiere no leer
          de más (y se precargaba en cada refresco automático). */}
      <Link href={toggleHref} prefetch={false} className="font-medium text-blue-600 hover:underline">
        {showHistory ? "Ver solo lo reciente" : "Ver todo el histórico"}
      </Link>
    </p>
  );
}
