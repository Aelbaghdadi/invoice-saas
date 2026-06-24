import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canReadInvoice } from "@/lib/invoiceAccess";
import { getObjectBytes } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * Sirve el binario de la factura por PROXY desde Garage (red interna). El
 * navegador pide esta URL same-origin (la devuelve /preview); aquí validamos el
 * acceso y hacemos stream del fichero. Garage nunca se expone públicamente.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: { storageKey: true, fileType: true, clientId: true, routingCandidateIds: true },
  });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!(await canReadInvoice(session.user, invoice))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const bytes = await getObjectBytes(invoice.storageKey);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": invoice.fileType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": "inline",
        // Datos sensibles (RGPD): no cachear en proxies/CDN intermedios.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Error al leer el archivo" },
      { status: 500 },
    );
  }
}
