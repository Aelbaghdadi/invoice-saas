import Link from "next/link";
import { Inbox } from "lucide-react";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { routingNeedsActionCount } from "@/lib/routingInbox";

/**
 * Aviso del inicio: facturas de una subida entre varios que esperan a alguien
 * (por clasificar o sin poder leerse). Esas no cuentan en ningún otro número
 * del inicio: no tienen empresa todavía. Sin nada pendiente no se pinta.
 */
export async function RoutingInboxNotice({ user }: { user: { id: string; role: string; advisoryFirmId?: string | null } }) {
  const count = await getAccessibleClientIds({ user }).then(routingNeedsActionCount).catch(() => 0);
  if (count === 0) return null;
  return (
    <Link
      href="/dashboard/worker/clasificar"
      className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800 transition hover:border-amber-300 hover:bg-amber-100/70"
    >
      <span className="flex items-center gap-2.5">
        <Inbox className="h-4 w-4 flex-shrink-0 text-amber-600" />
        {count === 1
          ? "1 factura de una subida entre varias empresas necesita que elijas su empresa o volver a leerse."
          : `${count} facturas de subidas entre varias empresas necesitan que elijas su empresa o volver a leerse.`}
      </span>
      <span className="flex-shrink-0 font-semibold">Ir al reparto →</span>
    </Link>
  );
}
