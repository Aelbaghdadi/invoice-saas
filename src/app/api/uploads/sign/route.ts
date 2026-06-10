import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase, sanitizeFilenameForStorage } from "@/lib/supabase";
import { appError } from "@/lib/errorCodes";
import { validateUploadedFile, canonicalMime } from "@/lib/fileValidation";
import { assertUploadClientAccess, assertUploadPeriodOpen } from "@/lib/uploadAccess";

/**
 * Pre-autoriza una subida directa del cliente a Supabase Storage.
 *
 * Hace TODAS las validaciones server-side ANTES de firmar:
 *  - Auth + tenancy (assertUploadClientAccess: CLIENT/WORKER/ADMIN).
 *  - Periodo abierto.
 *  - Tamano <= 20MB.
 *  - Magic-bytes del archivo (cliente manda los primeros 32B en base64).
 *    Asi rechazamos disguised executables antes de gastar storage.
 *  - Dedupe por fileHash (sha256). Si la factura ya existe activa, no
 *    firmamos URL — el cliente quita el archivo de la lista automaticamente.
 *
 * Si todo pasa, genera storageKey y devuelve la signed upload URL. El
 * cliente sube el binario directamente al storage y luego llama a
 * `/api/uploads/register` con la metadata.
 *
 * Razon de hacerlo asi: las Server Actions de Next 16 tienen un body
 * limit (default 1MB, max ~4MB en Vercel). Con N PDFs grandes el upload
 * via action peta. Subida directa esquiva ese limite y libera al
 * servidor del trafico binario.
 */
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const VALID_TYPES = new Set(["PURCHASE", "SALE"]);

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER", "CLIENT"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: appError("ERR-SYS-001", "json invalido") }, { status: 400 });
  }

  const {
    clientId, periodType, periodMonth, periodYear, type,
    filename, fileType, fileSize, fileHash, headBase64,
  } = body as Record<string, unknown>;

  const VALID_PERIOD_TYPES = new Set(["MONTHLY", "QUARTERLY"]);

  // Validaciones de forma minimas (los detalles vienen del client UI).
  if (typeof clientId !== "string" || !clientId) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-005", "clientId vacio") }, { status: 400 });
  }
  if (typeof periodMonth !== "number" || typeof periodYear !== "number") {
    return NextResponse.json({ error: appError("ERR-SYS-001", "periodo invalido") }, { status: 400 });
  }
  if (typeof periodType !== "string" || !VALID_PERIOD_TYPES.has(periodType)) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "periodType invalido") }, { status: 400 });
  }
  if (typeof type !== "string" || !VALID_TYPES.has(type)) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "tipo invalido") }, { status: 400 });
  }
  if (typeof filename !== "string" || !filename ||
      typeof fileSize !== "number" || fileSize <= 0 ||
      typeof fileHash !== "string" || !/^[a-f0-9]{64}$/.test(fileHash) ||
      typeof headBase64 !== "string" || !headBase64) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "metadata invalida") }, { status: 400 });
  }
  if (fileSize > MAX_FILE_SIZE) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-001", `${filename} (${fileSize} bytes)`) }, { status: 413 });
  }

  // Tenancy + periodo abierto.
  const access = await assertUploadClientAccess(session, clientId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: 403 });
  const periodOk = await assertUploadPeriodOpen(clientId, periodMonth, periodYear);
  if (!periodOk.ok) return NextResponse.json({ error: periodOk.error }, { status: 409 });

  // Magic bytes — usa los primeros 32B que mando el cliente. Validacion
  // defensiva contra archivos disguised que pasen el filtro client-side.
  const headBuf = Buffer.from(headBase64, "base64");
  const check = validateUploadedFile({
    buffer: headBuf,
    filename,
    declaredMime: typeof fileType === "string" ? fileType : undefined,
  });
  if (!check.ok) {
    return NextResponse.json(
      { error: appError("ERR-UPLOAD-002", `${filename}: ${check.reason}`) },
      { status: 415 },
    );
  }
  const realMime = canonicalMime(check.kind);

  // Dedupe pre-subida: si ya existe una factura activa con el mismo hash
  // del cliente, no firmamos URL. El cliente quita el archivo y muestra
  // "duplicado de X" sin que el gestor haga nada.
  const existing = await prisma.invoice.findFirst({
    where: { clientId, fileHash, status: { not: "REJECTED" } },
    select: { filename: true },
  });
  if (existing) {
    return NextResponse.json({ duplicate: true, of: existing.filename });
  }

  // Genera storageKey y signed upload URL.
  const supabase = createServerSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: appError("ERR-UPLOAD-003", "Storage no configurado") },
      { status: 500 },
    );
  }
  const safeName = sanitizeFilenameForStorage(filename);
  const periodSegment = periodType === "QUARTERLY"
    ? `${periodYear}-T${Math.ceil((periodMonth as number) / 3)}`
    : `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
  const storageKey = `${clientId}/${periodSegment}/${Date.now()}-${safeName}`;
  const signed = await supabase.storage.from("invoices").createSignedUploadUrl(storageKey);
  if (signed.error || !signed.data) {
    return NextResponse.json(
      { error: appError("ERR-UPLOAD-003", signed.error?.message ?? "sign fallo") },
      { status: 500 },
    );
  }

  return NextResponse.json({
    signedUrl: signed.data.signedUrl,
    token: signed.data.token,
    storageKey,
    realMime,
  });
}
