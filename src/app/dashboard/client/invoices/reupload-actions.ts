"use server";

import { after } from "next/server";
import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteObject, putObject, sanitizeFilenameForStorage, isStorageConfigured } from "@/lib/storage";
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
    return { error: "Solo se pueden volver a subir facturas rechazadas." };
  }
  if (rejected.replacedBy) {
    return { error: "Ya has subido una versión corregida de esta factura." };
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

  if (!isStorageConfigured()) return { error: "Almacenamiento no configurado." };
  const safeName = sanitizeFilenameForStorage(file.name);
  const storageKey = `${client.id}/${rejected.periodYear}-${String(rejected.periodMonth).padStart(2, "0")}/reupload-${Date.now()}-${safeName}`;

  try {
    await putObject(storageKey, Buffer.from(bytes), realMime);
  } catch (e) {
    return { error: `Error al subir: ${e instanceof Error ? e.message : "fallo"}` };
  }

  // Mientras se subia el fichero, el gestor ha podido reabrir y validar la
  // rechazada: si ademas se creara esta, irian las dos a A3. La transaccion
  // empieza volviendo a exigir REJECTED y sin sustituta, y toca updatedAt:
  // si la reapertura del gestor (condicionada a updatedAt) llega despues, ya
  // no escribe nada.
  let newId: string | null;
  try {
    newId = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: rejected.id, clientId: client.id, status: "REJECTED", replacedBy: { is: null } },
        data: { updatedAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const document = await tx.document.create({
        data: {
          filename: file.name,
          storageKey,
          fileType: realMime,
          fileHash,
          sizeBytes: file.size,
          uploadedBy: session.user.id,
          clientId: client.id,
        },
      });
      const newInvoice = await tx.invoice.create({
        data: {
          filename: file.name,
          storageKey,
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
      return newInvoice.id;
    });
  } catch (e) {
    // Otra resubida de la misma factura a la vez (replacesId es unico) u
    // otro fallo: no queda nada creado.
    console.error(`[reupload] ${rejected.id}: no se pudo registrar la resubida:`, e);
    await deleteObject(storageKey);
    return { error: "No se ha podido registrar la factura corregida. Recarga la página y vuelve a intentarlo." };
  }
  if (!newId) {
    await deleteObject(storageKey);
    return { error: "Esta factura ya no está rechazada. Recarga la página." };
  }

  const userId = session.user.id;
  const createdId = newId;
  after(async () => {
    await processInvoice(createdId, userId).catch(console.error);
  });

  revalidatePath("/dashboard/client/invoices");
  return { success: true };
}
