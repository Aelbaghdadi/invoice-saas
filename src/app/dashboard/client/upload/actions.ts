"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase, sanitizeFilenameForStorage } from "@/lib/supabase";
import { processInvoice } from "@/lib/processInvoice";
import { notifyWorkersNewUpload } from "@/lib/email";
import { InvoiceType } from "@prisma/client";
import { appError, type AppError } from "@/lib/errorCodes";

export type UploadState = {
  success?: boolean;
  count?: number;
  error?: AppError | string;
  warning?: string;
} | null;

export async function uploadInvoicesAction(
  _prev: UploadState,
  formData: FormData
): Promise<UploadState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "CLIENT") {
    return { error: "No autorizado." };
  }

  const files = formData.getAll("files") as File[];
  const periodMonth = parseInt(formData.get("periodMonth") as string, 10);
  const periodYear = parseInt(formData.get("periodYear") as string, 10);
  const type = formData.get("type") as InvoiceType;

  if (!files.length) return { error: "Selecciona al menos un archivo." };
  if (!periodMonth || !periodYear) return { error: "Selecciona mes y año." };
  if (!type) return { error: "Selecciona el tipo de factura." };

  const client = await prisma.client
    .findUnique({ where: { userId: session.user.id } })
    .catch(() => null);

  if (!client) return { error: "Perfil de cliente no encontrado." };

  // Check if the period is closed
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: {
        clientId: client.id,
        month: periodMonth,
        year: periodYear,
      },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: appError("ERR-UPLOAD-004", `${periodMonth}/${periodYear} clientId=${client.id}`) };
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

    // Magic-bytes validation
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

    // Calculate SHA-256 hash for duplicate detection
    const fileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

    // Solo bloqueamos duplicados activos. Las facturas RECHAZADAS pueden
    // re-subirse (el cliente arreglo el PDF y vuelve a mandar).
    const existingByHash = await prisma.invoice.findFirst({
      where: { clientId: client.id, fileHash, status: { not: "REJECTED" } },
      select: { filename: true },
    });
    if (existingByHash) {
      duplicates.push(`${file.name} (duplicado de ${existingByHash.filename})`);
      continue;
    }

    const safeName = sanitizeFilenameForStorage(file.name);
    const storageKey = `${client.id}/${periodYear}-${String(periodMonth).padStart(2, "0")}/${Date.now()}-${safeName}`;

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

    // Create Document record
    const document = await prisma.document.create({
      data: {
        filename: file.name,
        storageKey: supabase ? storageKey : `pending/${file.name}`,
        fileType: realMime,
        fileHash,
        sizeBytes: file.size,
        uploadedBy: session.user.id,
        clientId: client.id,
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
        clientId: client.id,
        documentId: document.id,
      },
    });

    createdIds.push(invoice.id);
    created.push(file.name);
  }

  // OCR de las facturas creadas — un solo worker secuencial en `after()`.
  // Antes hacia N `after()` paralelos y, con lotes grandes, saturaba
  // Document AI (rate limit 60 req/min). Secuencial: factura 1 lista
  // primero, las demas en cola pero sin error.
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

  // Notify assigned workers (after response)
  if (created.length > 0) {
    const clientName  = client.name;
    const clientId    = client.id;
    const uploadCount = created.length;
    after(async () => {
      try {
        const assignments = await prisma.workerClientAssignment.findMany({
          where: { clientId },
          include: { worker: { select: { email: true } } },
        });
        const emails = assignments.map((a) => a.worker.email);
        if (emails.length) {
          await notifyWorkersNewUpload({
            workerEmails: emails,
            clientName,
            count: uploadCount,
            periodMonth,
            periodYear,
          });
        }
      } catch (err) {
        console.error("[NOTIFY] Error notifying workers:", err);
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
