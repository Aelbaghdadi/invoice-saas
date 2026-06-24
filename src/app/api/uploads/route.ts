import { NextResponse, after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
import { notifyWorkersNewUpload } from "@/lib/email";
import { appError } from "@/lib/errorCodes";
import { validateUploadedFile, canonicalMime } from "@/lib/fileValidation";
import { assertUploadClientAccess, assertUploadPeriodOpen } from "@/lib/uploadAccess";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { putObject, sanitizeFilenameForStorage, isStorageConfigured } from "@/lib/storage";
import type { InvoiceType, PeriodType } from "@prisma/client";

/**
 * Subida de facturas en UN paso (multipart/form-data). El navegador envía el
 * binario aquí y la app lo sube a Garage (red interna) — antes la subida iba
 * directa del navegador a Supabase con URL firmada, pero Garage no es público,
 * así que la app hace de proxy. Valida auth/tenancy/periodo + magic-bytes +
 * dedupe, sube a Garage y crea Invoice + Document, igual que hacían sign+register.
 *
 * Campos del form: file, type, periodType, periodMonth, periodYear, y o bien
 * clientId (un cliente) o candidateClientIds (JSON, modo "clasificar").
 */
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const VALID_TYPES = new Set(["PURCHASE", "SALE", "UNKNOWN"]);
const VALID_PERIOD_TYPES = new Set(["MONTHLY", "QUARTERLY"]);

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER", "CLIENT"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-003", "Almacenamiento no configurado") }, { status: 500 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: appError("ERR-SYS-001", "form invalido") }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "falta el archivo") }, { status: 400 });
  }
  const clientId = form.get("clientId");
  const candidateRaw = form.get("candidateClientIds");
  const periodType = form.get("periodType");
  const periodMonth = Number(form.get("periodMonth"));
  const periodYear = Number(form.get("periodYear"));
  const type = form.get("type");

  if (
    typeof periodType !== "string" || !VALID_PERIOD_TYPES.has(periodType) ||
    !Number.isFinite(periodMonth) || !Number.isFinite(periodYear) ||
    typeof type !== "string" || !VALID_TYPES.has(type)
  ) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "metadata invalida") }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-001", `${file.name} (${file.size} bytes)`) }, { status: 413 });
  }

  // Modo "clasificar entre varios": candidateClientIds viene como JSON.
  let candidateClientIds: string[] = [];
  if (typeof candidateRaw === "string" && candidateRaw.trim()) {
    try {
      const arr = JSON.parse(candidateRaw);
      if (Array.isArray(arr)) candidateClientIds = arr.filter((x): x is string => typeof x === "string");
    } catch {
      return NextResponse.json({ error: appError("ERR-SYS-001", "candidatos invalidos") }, { status: 400 });
    }
  }
  const routingMode = candidateClientIds.length > 0;

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buffer).digest("hex");

  // Magic-bytes: defensa contra ficheros disfrazados. Mira la cabecera.
  const check = validateUploadedFile({
    buffer: buffer.subarray(0, 4100),
    filename: file.name,
    declaredMime: file.type || undefined,
  });
  if (!check.ok) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-002", `${file.name}: ${check.reason}`) }, { status: 415 });
  }
  const realMime = canonicalMime(check.kind);

  // Resolver cliente destino + accesos (defensa en profundidad).
  let effectiveClientId: string;
  let routingCandidateIds: string[] = [];
  let clientNameForNotify = "";
  if (routingMode) {
    if (!["ADMIN", "WORKER"].includes(session.user.role) || !session.user.advisoryFirmId) {
      return NextResponse.json({ error: appError("ERR-UPLOAD-005", "modo clasificar no permitido") }, { status: 403 });
    }
    for (const cid of candidateClientIds) {
      const acc = await assertUploadClientAccess(session, cid);
      if (!acc.ok) return NextResponse.json({ error: acc.error }, { status: 403 });
    }
    routingCandidateIds = candidateClientIds;
    const bucket = await getOrCreateUnclassifiedClient(session.user.advisoryFirmId);
    effectiveClientId = bucket.id;
  } else {
    if (typeof clientId !== "string" || !clientId) {
      return NextResponse.json({ error: appError("ERR-UPLOAD-005", "clientId vacio") }, { status: 400 });
    }
    const access = await assertUploadClientAccess(session, clientId);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: 403 });
    const periodOk = await assertUploadPeriodOpen(clientId, periodMonth, periodYear);
    if (!periodOk.ok) return NextResponse.json({ error: periodOk.error }, { status: 409 });
    effectiveClientId = clientId;
    clientNameForNotify = access.client.name;
  }

  // Dedupe por hash. En modo routing NO se deduplica (el cliente real aún no se
  // conoce; el duplicado se detecta tras rutear, vía detectIssues).
  if (!routingMode) {
    const existing = await prisma.invoice.findFirst({
      where: { clientId: effectiveClientId, fileHash, status: { not: "REJECTED" } },
      select: { filename: true },
    });
    if (existing) return NextResponse.json({ duplicate: true, of: existing.filename });
  }

  // Subir a Garage. La key la construye el SERVIDOR (sin confiar en el cliente).
  const safeName = sanitizeFilenameForStorage(file.name);
  const periodSegment = periodType === "QUARTERLY"
    ? `${periodYear}-T${Math.ceil(periodMonth / 3)}`
    : `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
  const storageKey = `${effectiveClientId}/${periodSegment}/${Date.now()}-${safeName}`;
  try {
    await putObject(storageKey, buffer, realMime);
  } catch (e) {
    return NextResponse.json(
      { error: appError("ERR-UPLOAD-003", e instanceof Error ? e.message : "fallo al subir") },
      { status: 500 },
    );
  }

  // Tipo "UNKNOWN" = subido como "Detectar automáticamente": placeholder + flag.
  const typeUnconfirmed = type === "UNKNOWN";
  const storedType: InvoiceType = type === "SALE" ? "SALE" : "PURCHASE";

  const document = await prisma.document.create({
    data: {
      filename: file.name,
      storageKey,
      fileType: realMime,
      fileHash,
      sizeBytes: file.size,
      uploadedBy: session.user.id,
      clientId: effectiveClientId,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      filename: file.name,
      storageKey,
      fileType: realMime,
      fileHash,
      type: storedType,
      typeUnconfirmed,
      periodType: periodType as PeriodType,
      periodMonth,
      periodYear,
      clientId: effectiveClientId,
      routingCandidateIds,
      documentId: document.id,
    },
  });

  const userId = session.user.id;
  after(async () => {
    await processInvoice(invoice.id, userId).catch((err) => {
      console.error(`[processInvoice] ${invoice.id} fallo:`, err);
    });
  });

  // Si sube un CLIENT, avisar a sus gestores (igual que el flujo anterior).
  if (session.user.role === "CLIENT") {
    after(async () => {
      try {
        const assignments = await prisma.workerClientAssignment.findMany({
          where: { clientId: effectiveClientId },
          include: { worker: { select: { email: true } } },
        });
        const emails = assignments.map((a) => a.worker.email);
        if (emails.length) {
          await notifyWorkersNewUpload({
            workerEmails: emails,
            clientName: clientNameForNotify,
            count: 1,
            periodMonth,
            periodYear,
          });
        }
      } catch (err) {
        console.error("[NOTIFY] Error notifying workers:", err);
      }
    });
  }

  return NextResponse.json({ invoiceId: invoice.id, filename: file.name });
}
