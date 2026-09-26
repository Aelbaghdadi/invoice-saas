import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appError } from "@/lib/errorCodes";
import { attachmentContentDisposition } from "@/lib/contentDisposition";
import { exportStorageKey, firmExportBatchWhere } from "@/lib/exportBatch";
import { exportExtension, exportFilename, type ExportFormat } from "@/lib/exportFormats";
import { getObjectBytes, isStorageConfigured, objectExists } from "@/lib/storage";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

/**
 * "Volver a descargar": el mismo fichero que se genero al exportar el lote.
 * Solo lectura; no marca nada. Solo ADMIN y solo lotes de su asesoria.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: appError("ERR-AUTH-002") }, { status: 403 });
  }
  const firmId = session.user.advisoryFirmId;
  if (!firmId) {
    return NextResponse.json({ error: appError("ERR-AUTH-002", "admin sin asesoría") }, { status: 403 });
  }

  const { id } = await params;
  // Un lote de otra asesoria da el mismo 404 que uno que no existe.
  const batch = await prisma.exportBatch.findFirst({
    where: firmExportBatchWhere(id, firmId),
    select: { id: true, format: true, clientId: true, periodMonth: true, periodYear: true },
  });
  if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const format = batch.format as ExportFormat;
  // Los lotes sin cliente son anteriores a guardar la copia: no la tienen.
  const key = batch.clientId ? exportStorageKey(firmId, batch.clientId, batch.id, format) : null;
  if (!key || !isStorageConfigured() || !(await objectExists(key))) {
    return NextResponse.json({ error: appError("ERR-EXPORT-005", `batch=${batch.id}`) }, { status: 404 });
  }

  const client = batch.clientId
    ? await prisma.client.findFirst({
        where: { id: batch.clientId, advisoryFirmId: firmId },
        select: { name: true },
      })
    : null;
  const filename = exportFilename(client?.name ?? null, format, batch.periodMonth ?? 0, batch.periodYear ?? 0);

  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(key);
  } catch (err) {
    console.error(`[export] no se pudo leer la copia batch=${batch.id}:`, err);
    return NextResponse.json({ error: appError("ERR-SYS-001", `batch=${batch.id}`) }, { status: 500 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPES[exportExtension(format)],
      "Content-Length": String(bytes.length),
      "Content-Disposition": attachmentContentDisposition(filename),
      // Datos fiscales (RGPD): no cachear en proxies intermedios.
      "Cache-Control": "private, no-store",
    },
  });
}
