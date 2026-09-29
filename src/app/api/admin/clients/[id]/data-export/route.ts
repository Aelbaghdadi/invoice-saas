import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkClientExport, recordClientExport, writeClientDataZip } from "@/lib/clientDataExport";

export const dynamic = "force-dynamic";

/**
 * Descarga de todos los datos de un cliente en un ZIP (F-044). Solo ADMIN y
 * solo clientes de su asesoria (si no, 404). Con `?check=1` solo comprueba
 * que se puede (el boton lo pregunta antes, para enseñar el error en la
 * pantalla en vez de descargar un JSON).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  }
  if (!session.user.advisoryFirmId) {
    return NextResponse.json({ error: "Tu usuario no está asociado a una asesoría" }, { status: 400 });
  }
  const { id } = await params;
  const check = await checkClientExport(id, session.user.advisoryFirmId);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  if (req.nextUrl.searchParams.get("check") === "1") return NextResponse.json({ ok: true });

  // El rastro, antes de enviar nada: sin él no hay descarga.
  await recordClientExport(id, session.user.id);
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const sink = async (chunk: Uint8Array) => {
    await writer.ready;
    await writer.write(chunk);
  };
  writeClientDataZip(check.client, user ? `${user.name} <${user.email}>` : session.user.id, sink).then(
    () => writer.close(),
    (err) => {
      // Las cabeceras ya han salido: el navegador ve la descarga cortada.
      console.error(`[clientDataExport] ${id}: la descarga se ha cortado:`, err);
      return writer.abort(err);
    },
  );

  const date = new Date().toISOString().slice(0, 10);
  const name = `datos-${check.client.cif}-${date}.zip`.replace(/[^\w.-]/g, "_");
  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
