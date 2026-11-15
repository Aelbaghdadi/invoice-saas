import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { recordAutoTicket } from "@/lib/autoTickets";
import { errorReportRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const MAX_FIELD = 2_000;

function field(value: unknown, max = MAX_FIELD): string | null {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : null;
}

/**
 * Un error que ha saltado en el navegador (la pantalla «Algo salió mal»).
 * Si trae digest, el error vino del servidor y ya lo apunto onRequestError:
 * no se duplica. Solo con sesion, y como mucho 20 cada 10 minutos por
 * usuario. Responde 204 siempre que la peticion sea valida: es un aviso, no
 * algo que el navegador tenga que gestionar.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Petición no válida" }, { status: 400 });
  if (field(body.digest)) return new NextResponse(null, { status: 204 });

  if (!errorReportRateLimit.check(`error-report:${session.user.id}`).allowed) {
    return new NextResponse(null, { status: 204 });
  }

  await recordAutoTicket({
    kind: "browser",
    name: field(body.name, 100) ?? "Error",
    message: field(body.message) ?? "",
    path: field(body.path, 300),
    stack: field(body.stack, 4_000),
    userId: session.user.id,
    firmId: session.user.advisoryFirmId ?? null,
    userAgent: req.headers.get("user-agent"),
  });
  return new NextResponse(null, { status: 204 });
}
