import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyFirmAuditChains } from "@/lib/auditLog";

// Verificacion completa de la cadena: recorre todos los registros de la
// firma, por tandas (F-048). Para firmas grandes puede tardar.
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
    return NextResponse.json({ error: "Tu usuario no está asociado a una asesoría" }, { status: 400 });
  }

  // Un fallo (pool lleno, statement_timeout, un Redeploy) llegaba al boton
  // como «Unexpected end of JSON input».
  try {
    const result = await verifyFirmAuditChains(session.user.advisoryFirmId);
    // El primer eslabon que falla, con la factura como la reconoce el admin.
    const first = result.breaks[0];
    const firstInvoice = first
      ? await prisma.invoice.findUnique({ where: { id: first.invoiceId }, select: { invoiceNumber: true, filename: true } })
      : null;
    return NextResponse.json({
      ...result,
      firstBreak: first ? { ...first, invoiceLabel: firstInvoice?.invoiceNumber ?? firstInvoice?.filename ?? first.invoiceId } : null,
    });
  } catch (err) {
    console.error("[verify-audit]", err);
    return NextResponse.json({ error: "No se pudo verificar la cadena. Inténtalo de nuevo." }, { status: 500 });
  }
}
