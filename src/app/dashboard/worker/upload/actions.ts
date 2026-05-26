"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase, sanitizeFilenameForStorage } from "@/lib/supabase";
import { processInvoice } from "@/lib/processInvoice";
import { InvoiceType } from "@prisma/client";
import { appError, type AppError } from "@/lib/errorCodes";

export type WorkerUploadState = {
  success?: boolean;
  count?: number;
  /** Error con codigo si es un fallo "conocido"; string para errores
   *  de validacion simples (campos del form sin rellenar, etc). */
  error?: AppError | string;
  warning?: string;
} | null;

export async function workerUploadInvoicesAction(
  _prev: WorkerUploadState,
  formData: FormData
): Promise<WorkerUploadState> {
  const session = await auth();
  if (!session?.user || !["ADMIN", "WORKER"].includes(session.user.role)) {
    return { error: "No autorizado." };
  }

  const files = formData.getAll("files") as File[];
  const clientId = formData.get("clientId") as string;
  const periodMonth = parseInt(formData.get("periodMonth") as string, 10);
  const periodYear = parseInt(formData.get("periodYear") as string, 10);
  const type = formData.get("type") as InvoiceType;

  if (!files.length) return { error: "Selecciona al menos un archivo." };
  if (!clientId) return { error: "Selecciona un cliente." };
  if (!periodMonth || !periodYear) return { error: "Selecciona mes y año." };
  if (!type) return { error: "Selecciona el tipo de factura." };

  // Verify client exists and worker is assigned to it (or is admin)
  if (session.user.role === "WORKER") {
    const assignment = await prisma.workerClientAssignment.findUnique({
      where: {
        workerId_clientId: {
          workerId: session.user.id,
          clientId,
        },
      },
    });
    if (!assignment) return { error: appError("ERR-UPLOAD-005", `clientId=${clientId} workerId=${session.user.id}`) };
  }

  // Check if the period is closed
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: { clientId, month: periodMonth, year: periodYear },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: appError("ERR-UPLOAD-004", `${periodMonth}/${periodYear} clientId=${clientId}`) };
  }

  const supabase = createServerSupabase();
  const created: string[] = [];
  const createdIds: string[] = [];
  const duplicates: string[] = [];

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

  for (const file of files) {
    if (!file.size) continue;
    if (file.size > MAX_FILE_SIZE) {
      return { error: appError("ERR-UPLOAD-001", `${file.name} (${file.size} bytes)`) };
    }

    const bytes = await file.arrayBuffer();

    // Magic-bytes validation: reject files whose real content does not match
    // the claimed extension/MIME (protects against disguised executables, etc)
    const { validateUploadedFile, canonicalMime } = await import("@/lib/fileValidation");
    const check = validateUploadedFile({
      buffer: bytes,
      filename: file.name,
      declaredMime: file.type,
    });
    if (!check.ok) {
      return { error: appError("ERR-UPLOAD-002", `${file.name}: ${check.reason}`) };
    }
    const realMime = canonicalMime(check.kind);

    const fileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

    // Solo bloqueamos duplicados activos. Las facturas RECHAZADAS pueden
    // re-subirse (caso tipico: el gestor rechazo por error o el cliente
    // arreglo el PDF y vuelve a mandar el original).
    const existingByHash = await prisma.invoice.findFirst({
      where: { clientId, fileHash, status: { not: "REJECTED" } },
      select: { filename: true },
    });
    if (existingByHash) {
      duplicates.push(`${file.name} (duplicado de ${existingByHash.filename})`);
      continue;
    }

    const safeName = sanitizeFilenameForStorage(file.name);
    const storageKey = `${clientId}/${periodYear}-${String(periodMonth).padStart(2, "0")}/${Date.now()}-${safeName}`;

    if (supabase) {
      const { error: storageError } = await supabase.storage
        .from("invoices")
        .upload(storageKey, bytes, {
          contentType: realMime,
          upsert: false,
        });
      if (storageError) {
        return { error: appError("ERR-UPLOAD-003", `${file.name}: ${storageError.message}`) };
      }
    }

    // Create Document record (source of truth for the physical file)
    const document = await prisma.document.create({
      data: {
        filename: file.name,
        storageKey: supabase ? storageKey : `pending/${file.name}`,
        fileType: realMime,
        fileHash,
        sizeBytes: file.size,
        uploadedBy: session.user.id,
        clientId,
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        filename: file.name,
        storageKey: supabase ? storageKey : `pending/${file.name}`,
        fileType: realMime,
        fileHash,
        type,
        periodMonth,
        periodYear,
        clientId,
        documentId: document.id,
      },
    });

    createdIds.push(invoice.id);
    created.push(file.name);
  }

  // OCR de las facturas creadas — un solo worker en `after()` que las
  // procesa SECUENCIALMENTE. Antes hacia N `after()` paralelos y, con
  // lotes grandes, saturaba Document AI (rate limit 60 req/min) y/o
  // agotaba el timeout de la function. Secuencialmente: factura 1 lista
  // en ~5s, factura 2 en ~10s, etc. El gestor empieza a revisar la
  // primera mientras el resto se sigue procesando.
  const userId = session.user.id;
  if (createdIds.length > 0) {
    after(async () => {
      for (const invoiceId of createdIds) {
        await processInvoice(invoiceId, userId).catch((err) => {
          console.error(`[processInvoice] ${invoiceId} fallo:`, err);
        });
      }
    });
  }

  if (created.length === 0 && duplicates.length > 0) {
    return { error: `Archivos duplicados: ${duplicates.join(", ")}` };
  }

  const warning = duplicates.length > 0
    ? ` (${duplicates.length} duplicado(s) omitido(s))`
    : "";

  return { success: true, count: created.length, warning };
}
