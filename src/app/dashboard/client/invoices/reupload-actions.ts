"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import { processInvoice } from "@/lib/processInvoice";

export type ReuploadState = {
  success?: boolean;
  error?: string;
} | null;

export async function reuploadInvoiceAction(
  _prev: ReuploadState,
  formData: FormData
): Promise<ReuploadState> {
  const session = await auth();
  if (!session?.user || session.user.role !== "CLIENT") {
    return { error: "No autorizado." };
  }

  const rejectedId = formData.get("rejectedId") as string;
  const file = formData.get("file") as File | null;
  if (!rejectedId) return { error: "Factura rechazada no especificada." };
  if (!file || !file.size) return { error: "Selecciona un archivo." };

  const client = await prisma.client
    .findUnique({ where: { userId: session.user.id } })
    .catch(() => null);
  if (!client) return { error: "Perfil de cliente no encontrado." };

  const rejected = await prisma.invoice.findUnique({
    where: { id: rejectedId },
    include: { replacedBy: true },
  });
  if (!rejected || rejected.clientId !== client.id) {
    return { error: "Factura no encontrada." };
  }
  if (rejected.status !== "REJECTED") {
    return { error: "Solo se pueden re-subir facturas rechazadas." };
  }
  if (rejected.replacedBy) {
    return { error: "Esta factura ya fue re-subida." };
  }

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
  if (file.size > MAX_FILE_SIZE) return { error: "El archivo supera el tamaño máximo de 20 MB." };

  const bytes = await file.arrayBuffer();

  // Magic-bytes validation
  const { validateUploadedFile, canonicalMime } = await import("@/lib/fileValidation");
  const check = validateUploadedFile({
    buffer: bytes,
    filename: file.name,
    declaredMime: file.type,
  });
  if (!check.ok) return { error: check.reason };
  const realMime = canonicalMime(check.kind);

  const fileHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

  // Reject if hash equals the rejected file (same content)
  if (rejected.fileHash && rejected.fileHash === fileHash) {
    return { error: "El archivo es idéntico al rechazado. Sube una versión corregida." };
  }

  const supabase = createServerSupabase();
  const storageKey = `${client.id}/${rejected.periodYear}-${String(rejected.periodMonth).padStart(2, "0")}/reupload-${Date.now()}-${file.name}`;

  if (supabase) {
    const { error: storageError } = await supabase.storage
      .from("invoices")
      .upload(storageKey, bytes, {
        contentType: realMime,
        upsert: false,
      });
    if (storageError) return { error: `Error al subir: ${storageError.message}` };
  }

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

  const newInvoice = await prisma.invoice.create({
    data: {
      filename: file.name,
      storageKey: supabase ? storageKey : `pending/${file.name}`,
      fileType: realMime,
      fileHash,
      type: rejected.type,
      periodMonth: rejected.periodMonth,
      periodYear: rejected.periodYear,
      clientId: client.id,
      documentId: document.id,
      replacesId: rejected.id,
    },
  });

  const newId = newInvoice.id;
  const userId = session.user.id;
  after(async () => {
    await processInvoice(newId, userId).catch(console.error);
  });

  revalidatePath("/dashboard/client/invoices");
  return { success: true };
}
