import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { verifyFirmAuditChains } from "@/lib/auditLog";

// Verificacion completa de la cadena: recorre todos los registros de
// todas las facturas de la firma. Para firmas grandes puede tardar; le
// damos margen de tiempo Vercel (60s).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Devuelve el estado de la cadena de auditoria de la firma del admin.
 * Solo ADMIN. No modifica nada — pura lectura.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  }
  if (!session.user.advisoryFirmId) {
    return NextResponse.json({ error: "Tu usuario no esta asociado a una asesoria" }, { status: 400 });
  }

  const result = await verifyFirmAuditChains(session.user.advisoryFirmId);
  return NextResponse.json(result);
}
