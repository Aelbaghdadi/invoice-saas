import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyCronSecret } from "@/lib/cronAuth";
import { isStorageConfigured } from "@/lib/storage";
import {
  ARCHIVE_MEDIUM_BACKFILL_LIMIT,
  countPendingMediumBackfill,
  runArchiveMediumBackfill,
} from "@/lib/archiveMediumBackfill";

const querySchema = z.object({
  dryRun: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_MEDIUM_BACKFILL_LIMIT.max).optional(),
});

/**
 * Electrónico o papel de los PDF de antes del archivo (anexo C3): repasa unas
 * cuantas por llamada. Se lanza a mano (o con la Scheduled Task) tras
 * desplegar la migración 12, hasta que `quedan` sea 0. Con ?dryRun=1 solo
 * cuenta las pendientes, sin descargar ni escribir.
 */
async function handle(req: Request) {
  if (!verifyCronSecret(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Parámetros no válidos: dryRun=1 para solo contar y limit de 1 a ${ARCHIVE_MEDIUM_BACKFILL_LIMIT.max}.` },
      { status: 400 },
    );
  }
  if (parsed.data.dryRun === "1") {
    return NextResponse.json({ dryRun: true, quedan: await countPendingMediumBackfill() });
  }
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: "Almacenamiento (S3) no configurado." }, { status: 503 });
  }
  return NextResponse.json(await runArchiveMediumBackfill({ limit: parsed.data.limit }));
}

// GET y POST, como los demás crons: la Scheduled Task usa el que pueda.
export const GET = handle;
export const POST = handle;
