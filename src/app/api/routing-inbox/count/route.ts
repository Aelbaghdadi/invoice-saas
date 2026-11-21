import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessibleClientIds } from "@/lib/accessibleClients";
import { routingNeedsActionCount } from "@/lib/routingInbox";

export const dynamic = "force-dynamic";

/**
 * Cuántas facturas del reparto esperan a alguien, para el contador del menú.
 * El menú lo pide al cambiar de página y cada poco: el layout que lo pinta no
 * se vuelve a renderizar al navegar, y el número se quedaba viejo.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["ADMIN", "WORKER"].includes(session.user.role)) return NextResponse.json({ count: 0 });
  const count = await routingNeedsActionCount(await getAccessibleClientIds(session));
  return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
}
