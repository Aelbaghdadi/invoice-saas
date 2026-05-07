import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { reseedDemo } from "@/lib/demoSeed";

// El reseed lee/escribe BD + sube a Storage; necesita un timeout amplio
// para no cortarse a media operacion. 60s = limite Vercel Pro.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Reset de la demo: borra los datos no-admin de la firma y los reemplaza
 * con el dataset declarado en demoSeedData.ts. Solo accesible por ADMIN.
 *
 * Doble confirmacion: el cliente debe enviar `confirm: "RESET"` en el body
 * para evitar disparos accidentales por curl o link compartido.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  }
  if (!session.user.advisoryFirmId) {
    return NextResponse.json({ error: "Tu usuario no esta asociado a una asesoria" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== "RESET") {
    return NextResponse.json(
      { error: "Falta confirmacion. Envia { confirm: 'RESET' } en el body." },
      { status: 400 },
    );
  }

  try {
    const result = await reseedDemo(session.user.advisoryFirmId, session.user.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[reset-demo] error:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
