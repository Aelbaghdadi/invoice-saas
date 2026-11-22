import { NextResponse, after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processInvoice } from "@/lib/processInvoice";
import { noteUpload } from "@/lib/uploadNotices";
import { notifyWorkersNewUpload } from "@/lib/email";
import { appError } from "@/lib/errorCodes";
import { validateUploadedFile, canonicalMime } from "@/lib/fileValidation";
import { assertUploadClientAccess, assertUploadPeriodOpen } from "@/lib/uploadAccess";
import { getOrCreateUnclassifiedClient } from "@/lib/unclassifiedClient";
import { deleteObject, putObject, sanitizeFilenameForStorage, isStorageConfigured } from "@/lib/storage";
import { uploadStorageKey } from "@/lib/uploadStorageKey";
import { archiveIntakeFields } from "@/lib/archiveIntake";
import { recordAutoTicket } from "@/lib/autoTickets";
import { formatDateEs } from "@/lib/dates";
import { periodLabel } from "@/lib/period";
import { CLIENT_STATUS_BADGE, STATUS_LABELS } from "@/lib/invoiceStatuses";
import { archiveFileKind } from "@/lib/originalMedium";
import { checkUploadBatchForFile, createWholeTaco, isUploadPositionTaken } from "@/lib/uploadBatches";
import type { InvoiceType, PeriodType } from "@prisma/client";

/**
 * Subida de facturas en UN paso (multipart/form-data). El navegador envía el
 * binario aquí y la app lo sube a Garage (red interna) — antes la subida iba
 * directa del navegador a Supabase con URL firmada, pero Garage no es público,
 * así que la app hace de proxy. Valida auth/tenancy/periodo + magic-bytes +
 * dedupe, sube a Garage y crea Document, Invoice y su fila de archivo en una
 * sola transacción.
 *
 * Campos del form: file, type, periodType, periodMonth, periodYear, y o bien
 * clientId (un cliente) o candidateClientIds (JSON, modo "clasificar").
 * Opcionales, solo del gestor: uploadBatchId + uploadPosition (la tanda del
 * «Subir» y la posición del fichero en su lista, que en un taco es la página)
 * o wholeTaco=1 (el PDF de un taco entero, que crea el taco y no es factura).
 */
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const VALID_TYPES = new Set(["PURCHASE", "SALE", "UNKNOWN"]);
const VALID_PERIOD_TYPES = new Set(["MONTHLY", "QUARTERLY"]);

/** Una tanda que se fue (anulada) entre la comprobación y el alta. */
class BatchGoneError extends Error {}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: appError("ERR-AUTH-001") }, { status: 401 });
  }
  if (!["ADMIN", "WORKER", "CLIENT"].includes(session.user.role)) {
    return NextResponse.json({ error: appError("ERR-AUTH-002", `rol ${session.user.role}`) }, { status: 403 });
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

  // Tanda y posición van juntas; el taco entero, sin ninguna de las dos.
  const batchIdRaw = form.get("uploadBatchId");
  const positionRaw = form.get("uploadPosition");
  const wholeTaco = form.get("wholeTaco") === "1";
  const hasBatchId = typeof batchIdRaw === "string" && batchIdRaw !== "";
  const hasPosition = typeof positionRaw === "string" && positionRaw !== "";
  if (hasBatchId !== hasPosition || (wholeTaco && hasBatchId)) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "tanda incompleta") }, { status: 400 });
  }
  const batchRef = hasBatchId ? { batchId: batchIdRaw as string, position: Number(positionRaw) } : null;
  if (batchRef && !Number.isInteger(batchRef.position)) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "posición en la tanda inválida") }, { status: 400 });
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
  if (wholeTaco && routingMode) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-005", "el taco entero se sube a un solo cliente") }, { status: 400 });
  }

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

  if (session.user.role === "CLIENT" && (batchRef || wholeTaco)) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-008", "el portal no sube en tandas") }, { status: 403 });
  }

  // El taco entero: crea el taco con su PDF, sin factura ni análisis (B-R9).
  if (wholeTaco) {
    const taco = await createWholeTaco(session, {
      clientId: effectiveClientId,
      periodType: periodType as PeriodType,
      periodMonth,
      periodYear,
      invoiceType: type as "PURCHASE" | "SALE" | "UNKNOWN",
      file: { name: file.name, buffer, fileHash, mime: realMime },
    });
    if ("duplicate" in taco) return NextResponse.json({ duplicate: true, of: taco.of });
    if (!taco.ok) return NextResponse.json({ error: taco.error }, { status: taco.status });
    return NextResponse.json({
      tacoPdf: true,
      batchId: taco.batchId,
      tacoNumber: taco.tacoNumber,
      pageCount: taco.pageCount,
      ...(taco.alreadyUploaded ? { alreadyUploaded: true } : {}),
    });
  }

  // Con tanda: que la admita (B-R4) y que su posición esté libre (B-R5),
  // antes de subir nada al almacenamiento.
  let batch: { id: string; tacoNumber: number | null; createdAt: Date } | null = null;
  if (batchRef) {
    const check = await checkUploadBatchForFile(session, batchRef, {
      clientId: routingMode ? null : effectiveClientId,
      candidateClientIds: routingCandidateIds,
      periodType: periodType as PeriodType,
      periodMonth,
      periodYear,
      type,
      fileKind: archiveFileKind(realMime),
    });
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
    batch = check.batch;
    const occupied = await positionResponse(batch.id, batchRef.position, fileHash, file.name);
    if (occupied) return occupied;
  }

  // Dedupe por hash. En modo routing NO se deduplica (el cliente real aún no se
  // conoce; el duplicado se detecta tras rutear, vía detectIssues).
  if (!routingMode) {
    const existing = await prisma.invoice.findFirst({
      where: { clientId: effectiveClientId, fileHash, status: { not: "REJECTED" } },
      select: {
        filename: true,
        invoiceNumber: true,
        createdAt: true,
        periodType: true,
        periodMonth: true,
        periodYear: true,
        status: true,
      },
    });
    if (existing) {
      // Un reintento cuyo primer intento se ha registrado después de mirar la
      // página (respuesta perdida y el primero aún en curso): el «duplicado» es
      // él mismo, y la página dice si es un reintento (200) o está ocupada (409).
      if (batch && batchRef) {
        const occupied = await positionResponse(batch.id, batchRef.position, fileHash, file.name);
        if (occupied) return occupied;
      }
      // Los formularios de subida lo pintan tal cual tras "duplicado de". Solo
      // con el nombre del fichero, al subir el mismo PDF se repetia su propio
      // nombre y no se sabia cuando se subio ni como esta. El cliente ve el
      // estado de su portal ("En proceso"), no el interno del gestor.
      const statusLabel = session.user.role === "CLIENT"
        ? CLIENT_STATUS_BADGE[existing.status].label
        : STATUS_LABELS[existing.status];
      const of = [
        existing.invoiceNumber ? `factura ${existing.invoiceNumber}` : existing.filename,
        `subida el ${formatDateEs(existing.createdAt)}`,
        periodLabel(existing.periodType, existing.periodMonth, existing.periodYear),
        statusLabel,
      ].join(" · ");
      return NextResponse.json({ duplicate: true, of });
    }
  }

  // Subir a Garage. La key la construye el SERVIDOR (sin confiar en el cliente)
  // y es única: nunca sobrescribe el original de otra subida.
  const storageKey = uploadStorageKey(
    { clientId: effectiveClientId, periodType: periodType as PeriodType, periodMonth, periodYear },
    sanitizeFilenameForStorage(file.name),
  );
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
  const archive = {
    ...archiveIntakeFields({
      fileType: realMime,
      uploadedByClient: session.user.role === "CLIENT",
      inTaco: batch?.tacoNumber != null,
    }),
    // La llegada de lo que se sube junto es la creación de su tanda (B-R8).
    ...(batch && batchRef ? { uploadBatchId: batch.id, uploadPosition: batchRef.position, receivedAt: batch.createdAt } : {}),
  };

  let invoice: { id: string };
  try {
    invoice = await prisma.$transaction(async (tx) => {
      if (batch) {
        // FOR SHARE frente al FOR UPDATE de una anulación: o esta factura entra
        // antes y la anulación la ve, o la anulación va antes y aquí no sale (B-R22).
        const alive = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "UploadBatch" WHERE "id" = ${batch.id} AND "voidedAt" IS NULL FOR SHARE`;
        if (alive.length === 0) throw new BatchGoneError();
      }
      const document = await tx.document.create({
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
      const created = await tx.invoice.create({
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
        select: { id: true },
      });
      // La fila la ha creado el trigger (llegada = alta de la factura).
      if (Object.keys(archive).length > 0) await tx.invoiceArchive.update({ where: { invoiceId: created.id }, data: archive });
      return created;
    });
  } catch (e) {
    // No queda ni Document ni Invoice: el fichero recién subido sobra, y su
    // clave es única, así que no es el de nadie más.
    await deleteObject(storageKey);
    if (e instanceof BatchGoneError) {
      return NextResponse.json({ error: appError("ERR-UPLOAD-008", `tanda ${batch?.id} anulada al subir`) }, { status: 409 });
    }
    // Otra subida ha llegado antes a la misma página: es la de este mismo
    // fichero (un reintento) u otro.
    if (batch && batchRef && isUploadPositionTaken(e)) {
      const occupied = await positionResponse(batch.id, batchRef.position, fileHash, file.name);
      if (occupied) return occupied;
    }
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(`[uploads] no se pudo registrar ${storageKey}:`, error);
    // Antes este fallo salía como excepción y abría el ticket automático
    // (instrumentation.ts); al capturarlo se abre aquí.
    await recordAutoTicket({
      kind: "server",
      name: error.name,
      message: error.message,
      path: "/api/uploads",
      routePath: "/api/uploads",
      routeType: "route",
      method: "POST",
      stack: error.stack ?? null,
      userId: session.user.id,
      firmId: session.user.advisoryFirmId ?? null,
    });
    return NextResponse.json({ error: appError("ERR-SYS-001", "no se pudo registrar la factura") }, { status: 500 });
  }

  const userId = session.user.id;
  after(async () => {
    await processInvoice(invoice.id, userId).catch((err) => {
      console.error(`[processInvoice] ${invoice.id} fallo:`, err);
    });
  });

  // Si sube un CLIENT, avisar a sus gestores: un aviso por subida, no por
  // fichero (F-040). Cada fichero llega en su propia petición; noteUpload
  // junta los del mismo cliente y periodo y avisa cuando dejan de llegar.
  if (session.user.role === "CLIENT") {
    const notifyPeriodType = periodType as PeriodType;
    noteUpload(`${effectiveClientId}|${notifyPeriodType}|${periodMonth}|${periodYear}`, async (count) => {
      const assignments = await prisma.workerClientAssignment.findMany({
        where: { clientId: effectiveClientId },
        include: { worker: { select: { email: true } } },
      });
      const emails = assignments.map((a) => a.worker.email);
      if (emails.length) {
        await notifyWorkersNewUpload({
          workerEmails: emails,
          clientName: clientNameForNotify,
          count,
          periodMonth,
          periodYear,
          periodType: notifyPeriodType,
        });
      }
    });
  }

  return NextResponse.json({ invoiceId: invoice.id, filename: file.name });
}

/**
 * La posición de la tanda ya tiene factura (B-R5): con el mismo fichero es un
 * reintento que sí llegó (200, sin crear otra); con otro, 409. null si está
 * libre.
 */
async function positionResponse(batchId: string, position: number, fileHash: string, filename: string) {
  const occupied = await prisma.invoiceArchive.findFirst({
    where: { uploadBatchId: batchId, uploadPosition: position, splitPart: 0 },
    select: { invoice: { select: { id: true, fileHash: true } } },
  });
  if (!occupied) return null;
  if (occupied.invoice.fileHash === fileHash) {
    return NextResponse.json({ invoiceId: occupied.invoice.id, filename, alreadyUploaded: true });
  }
  return NextResponse.json(
    { error: appError("ERR-UPLOAD-009", `tanda ${batchId}, posición ${position}`) },
    { status: 409 },
  );
}
