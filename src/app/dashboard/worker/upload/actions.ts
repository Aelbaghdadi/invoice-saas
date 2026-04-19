"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import { processInvoice } from "@/lib/processInvoice";
import { InvoiceType } from "@prisma/client";

export type WorkerUploadState = {
  success?: boolean;
  count?: number;
  error?: string;
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
    if (!assignment) return { error: "No tienes acceso a este cliente." };
  }

  // Check if the period is closed
  const closure = await prisma.periodClosure.findUnique({
    where: {
      clientId_month_year: { clientId, month: periodMonth, year: periodYear },
    },
  });
  if (closure && !closure.reopenedAt) {
    return { error: `El periodo ${periodMonth}/${periodYear} está cerrado.` };
  }

  const supabase = createServerSupabase();
  const created: string[] = [];
  const duplicates: string[] = [];

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

  for (const file of files) {
    if (!file.size) continue;
    if (file.size > MAX_FILE_SIZE) {
      return { error: `${file.name} supera el tamaño máximo de 20 MB.` };
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
      return { error: `${file.name}: ${check.reason}` };
    }
    const realMime = canonicalMime(check.kind);

    const fileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

    const existingByHash = await prisma.invoice.findFirst({
      where: { clientId, fileHash },
      select: { filename: true },
    });
    if (existingByHash) {
      duplicates.push(`${file.name} (duplicado de ${existingByHash.filename})`);
      continue;
    }

    const storageKey = `${clientId}/${periodYear}-${String(periodMonth).padStart(2, "0")}/${Date.now()}-${file.name}`;

    if (supabase) {
      const { error: storageError } = await supabase.storage
        .from("invoices")
        .upload(storageKey, bytes, {
          contentType: realMime,
          upsert: false,
        });
      if (storageError) {
        return { error: `Error al subir ${file.name}: ${storageError.message}` };
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

    const invoiceId = invoice.id;
    const userId = session.user.id;
    after(async () => {
      await processInvoice(invoiceId, userId).catch(console.error);
    });

    created.push(file.name);
  }

  if (created.length === 0 && duplicates.length > 0) {
    return { error: `Archivos duplicados: ${duplicates.join(", ")}` };
  }

  const warning = duplicates.length > 0
    ? ` (${duplicates.length} duplicado(s) omitido(s))`
    : "";

  return { success: true, count: created.length, warning };
}
