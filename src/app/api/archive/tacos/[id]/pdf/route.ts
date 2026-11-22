import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canAccessUploadBatch } from "@/lib/archiveAccess";
import { prisma } from "@/lib/prisma";
import { getObjectBytes, isStorageNotFound } from "@/lib/storage";
import { invoiceFileHeaders } from "@/lib/invoiceFileHeaders";

export const dynamic = "force-dynamic";

/**
 * El PDF de un taco entero, tal como se subió (B-R9): la pantalla de las
 * marcas lo pinta en miniaturas y el detalle lo abre con «Ver el PDF del taco
 * entero». Solo para quien ve el taco (B-R20; el ADMIN, los de su asesoría):
 * sin acceso, sin PDF o en un taco de factura a factura, 404, para no decir si
 * existe. La CSP sandbox y nosniff de esta ruta están en next.config.ts.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const firmId = session.user.advisoryFirmId;
  if (!firmId || !(await canAccessUploadBatch(session, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const document = await prisma.document.findFirst({
    where: { tacoPdfBatch: { id, advisoryFirmId: firmId, wholePdf: true }, client: { advisoryFirmId: firmId } },
    select: { storageKey: true, fileType: true, filename: true },
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const bytes = await getObjectBytes(document.storageKey);
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...invoiceFileHeaders(document.fileType, id, document.filename),
        "Content-Length": String(bytes.length),
        // Datos sensibles (RGPD): no cachear en proxies/CDN intermedios.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (isStorageNotFound(err)) {
      // Un PDF que falta es grave: hasta dividirlo, es el único papel del taco.
      console.error(`[archivo] falta el PDF del taco ${id} en el almacenamiento: ${document.storageKey}`);
      return NextResponse.json({ error: "El PDF del taco no está en el almacenamiento." }, { status: 404 });
    }
    return NextResponse.json({ error: "No se pudo leer el PDF del taco." }, { status: 500 });
  }
}
