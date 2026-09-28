import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";

// Sin sesion: lo llama el health check de Coolify y un monitor externo. No
// revela nada interno, solo { db, storage }. Nunca de cache.
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await checkHealth();
  const ok = status.db && status.storage;
  return NextResponse.json(status, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
