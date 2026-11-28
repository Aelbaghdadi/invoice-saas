import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canAccessArchiveInvoice } from "@/lib/archiveAccess";
import { archiveOriginalFile } from "@/lib/archiveData";
import { getObjectBytes, isStorageNotFound } from "@/lib/storage";
import { invoiceFileHeaders } from "@/lib/invoiceFileHeaders";

export const dynamic = "force-dynamic";

/**
 * El original de una factura del archivo, a un clic: el adjunto en otro
 * formato si lo hay (Word, Excel…, siempre como descarga); si no, el documento
 * entero si es una parte de una división; si no, el suyo. Con ?copia=1, el
 * fichero que lee la app. Comprueba la asesoría también para el ADMIN y
 * responde 404 sin acceso, para no decir si existe. La CSP
 * sandbox y nosniff de esta ruta están en next.config.ts.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const firmId = session.user.advisoryFirmId;
  if (!firmId || !(await canAccessArchiveInvoice(session, id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const file = await archiveOriginalFile(id, firmId, { copy: req.nextUrl.searchParams.get("copia") === "1" });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const bytes = await getObjectBytes(file.storageKey);
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...invoiceFileHeaders(file.fileType, id, file.filename),
        "Content-Length": String(bytes.length),
        // Datos sensibles (RGPD): no cachear en proxies/CDN intermedios.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (isStorageNotFound(err)) {
      // Un original que falta es grave: el archivo promete conservarlo.
      console.error(`[archivo] falta el original de ${id} en el almacenamiento (${file.kind}): ${file.storageKey}`);
      return NextResponse.json({ error: "El original no está en el almacenamiento." }, { status: 404 });
    }
    return NextResponse.json({ error: "No se pudo leer el original." }, { status: 500 });
  }
}
