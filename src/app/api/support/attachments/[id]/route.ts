import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getObjectBytes, isStorageNotFound } from "@/lib/storage";
import { supportActorFor } from "@/lib/supportAccess";
import { canReadTicket, canUseSupport } from "@/lib/support";
import { attachmentContentDisposition } from "@/lib/contentDisposition";

export const dynamic = "force-dynamic";

/** Lo que el navegador pinta sin ejecutar nada; el resto se descarga. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

/**
 * El adjunto de un mensaje de soporte, por proxy desde el almacenamiento y
 * con el mismo control de acceso que el ticket. La CSP sandbox y nosniff de
 * esta ruta van en next.config.ts.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const actor = await supportActorFor(session.user);
  if (!canUseSupport(actor.role) && !actor.staff) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  const { id } = await params;
  const message = await prisma.supportMessage.findUnique({
    where: { id },
    select: {
      attachmentKey: true,
      attachmentName: true,
      attachmentType: true,
      ticket: { select: { advisoryFirmId: true, createdById: true } },
    },
  });
  if (!message || !canReadTicket(actor, message.ticket)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!message.attachmentKey) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const bytes = await getObjectBytes(message.attachmentKey);
    const mime = message.attachmentType ?? "application/octet-stream";
    const inline = INLINE_TYPES.has(mime);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": inline ? mime : "application/octet-stream",
        "Content-Disposition": inline ? "inline" : attachmentContentDisposition(message.attachmentName ?? "adjunto"),
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (isStorageNotFound(err)) return NextResponse.json({ error: "El adjunto ya no está en el almacenamiento" }, { status: 404 });
    return NextResponse.json({ error: "No se pudo leer el adjunto" }, { status: 500 });
  }
}
