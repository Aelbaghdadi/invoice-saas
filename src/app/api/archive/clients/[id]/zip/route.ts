import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkArchiveExport, recordArchiveExport, writeArchiveZip } from "@/lib/archiveExport";

export const dynamic = "force-dynamic";

const FISCAL_YEAR = "Elige el ejercicio.";
const QUARTER = "El trimestre va del 1 al 4.";
const INVALID = "Parámetros no válidos.";

const query = z.object({
  ejercicio: z.coerce.number({ error: FISCAL_YEAR }).int(FISCAL_YEAR).min(1900, FISCAL_YEAR).max(2999, FISCAL_YEAR),
  trimestre: z.coerce.number({ error: QUARTER }).int(QUARTER).min(1, QUARTER).max(4, QUARTER).nullish(),
  solo: z.enum(["registradas"], { error: INVALID }).nullish(),
  rechazadas: z.enum(["0", "1"], { error: INVALID }).nullish(),
  check: z.enum(["0", "1"], { error: INVALID }).nullish(),
});

/**
 * El archivo de un ejercicio de un cliente en un ZIP (R20): ?ejercicio=2026
 * (el año en que empieza), &trimestre=1..4 del ejercicio, &solo=registradas,
 * &rechazadas=1. Solo ADMIN y solo clientes de su asesoría (si no, 404). Con
 * &check=1 solo comprueba que se puede, para enseñar el error en la pantalla
 * en vez de descargar un JSON.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Solo administradores" }, { status: 403 });
  const firmId = session.user.advisoryFirmId;
  if (!firmId) return NextResponse.json({ error: "Tu usuario no está asociado a una asesoría" }, { status: 400 });

  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? INVALID }, { status: 400 });
  }
  const { id } = await params;
  const check = await checkArchiveExport(id, firmId, {
    fiscalYear: parsed.data.ejercicio,
    quarter: parsed.data.trimestre ?? null,
    onlyRegistered: parsed.data.solo === "registradas",
    includeRejected: parsed.data.rechazadas === "1",
  });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  const { archive } = check;
  if (parsed.data.check === "1") return NextResponse.json({ ok: true, invoices: archive.invoices.length });

  // El rastro, antes de enviar nada: sin él no hay descarga.
  await recordArchiveExport(archive, session.user.id);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const sink = async (chunk: Uint8Array) => {
    await writer.ready;
    await writer.write(chunk);
  };
  writeArchiveZip(archive, sink).then(
    () => writer.close(),
    (err) => {
      // Las cabeceras ya han salido: el navegador ve la descarga cortada.
      console.error(`[archiveExport] ${id}: la descarga se ha cortado:`, err);
      return writer.abort(err);
    },
  );

  const quarter = archive.options.quarter ? `-T${archive.options.quarter}` : "";
  const name = `archivo-${archive.client.cif}-${archive.fiscalYear.label}${quarter}.zip`.replace(/[^\w.-]/g, "_");
  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
