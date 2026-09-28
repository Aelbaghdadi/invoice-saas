import { NextResponse } from "next/server";
import { checkLiveness } from "@/lib/health";

// Para el health check de Coolify: proceso y Postgres, sin el almacenamiento
// (ver checkLiveness). El completo, para el monitor externo, es /api/health.
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await checkLiveness();
  return NextResponse.json(status, { status: status.db ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
