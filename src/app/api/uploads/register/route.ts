import { NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createServerSupabase } from "@/lib/supabase";
import { processInvoice } from "@/lib/processInvoice";
import { notifyWorkersNewUpload } from "@/lib/email";
import { appError } from "@/lib/errorCodes";
import { assertUploadClientAccess, assertUploadPeriodOpen } from "@/lib/uploadAccess";
import type { InvoiceType } from "@prisma/client";

/**
 * Segunda fase de la subida directa: el cliente ya subio el binario al
 * Storage (con la signed URL de `/api/uploads/sign`) y ahora pide
 * registrar la Invoice + Document en BD.
 *
 * Re-valida todo (defensa en profundidad): auth, tenancy, periodo, y
 * dedupe por fileHash. Si entre sign y register surgio un duplicado
 * (race: dos uploads simultaneos del mismo file), borra el blob que
 * acabamos de subir y devuelve `{ duplicate: true, of: ... }`.
 *
 * Si todo OK, crea Document + Invoice y dispara processInvoice via
 * `after()` (igual que la accion legacy).
 */
export const dynamic = "force-dynamic";

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
    clientId, periodMonth, periodYear, type,
    filename, fileType, fileSize, fileHash, storageKey,
  } = body as Record<string, unknown>;

  if (typeof clientId !== "string" || !clientId ||
      typeof periodMonth !== "number" ||
      typeof periodYear !== "number" ||
      typeof type !== "string" || !VALID_TYPES.has(type) ||
      typeof filename !== "string" || !filename ||
      typeof fileType !== "string" || !fileType ||
      typeof fileSize !== "number" || fileSize <= 0 ||
      typeof fileHash !== "string" || !/^[a-f0-9]{64}$/.test(fileHash) ||
      typeof storageKey !== "string" || !storageKey) {
    return NextResponse.json({ error: appError("ERR-SYS-001", "metadata invalida") }, { status: 400 });
  }

  // Defensa en profundidad: re-validamos aunque /sign ya lo hizo.
  const access = await assertUploadClientAccess(session, clientId);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: 403 });
  const periodOk = await assertUploadPeriodOpen(clientId, periodMonth, periodYear);
  if (!periodOk.ok) return NextResponse.json({ error: periodOk.error }, { status: 409 });

  // El storageKey DEBE empezar por `<clientId>/` — defiende contra que
  // alguien envie un storageKey de otra factura/firma.
  if (!storageKey.startsWith(`${clientId}/`)) {
    return NextResponse.json({ error: appError("ERR-UPLOAD-005", "storageKey fuera del cliente") }, { status: 403 });
  }

  // Race-condition: chequeo final por hash. Si surgio un duplicado entre
  // /sign y /register, borramos el blob y devolvemos duplicate. (No
  // creamos la Invoice — equivalente a "el cliente quita el archivo".)
  const existing = await prisma.invoice.findFirst({
    where: { clientId, fileHash, status: { not: "REJECTED" } },
    select: { filename: true },
  });
  if (existing) {
    const supabase = createServerSupabase();
    if (supabase) {
      await supabase.storage.from("invoices").remove([storageKey]).catch(() => null);
    }
    return NextResponse.json({ duplicate: true, of: existing.filename });
  }

  const document = await prisma.document.create({
    data: {
      filename,
      storageKey,
      fileType,
      fileHash,
      sizeBytes: fileSize,
      uploadedBy: session.user.id,
      clientId,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      filename,
      storageKey,
      fileType,
      fileHash,
      type: type as InvoiceType,
      periodMonth,
      periodYear,
      clientId,
      documentId: document.id,
    },
  });

  // OCR en background. Antes la accion lanzaba TODAS en serie en un
  // unico after() — con subida directa cada archivo dispara su propio
  // processInvoice, lo que casa con el rate limit de Document AI (60
  // req/min) sin saturar.
  const userId = session.user.id;
  after(async () => {
    await processInvoice(invoice.id, userId).catch((err) => {
      console.error(`[processInvoice] ${invoice.id} fallo:`, err);
    });
  });

  // Notificar workers cuando es el CLIENT quien sube. Mismo flujo que
  // la accion legacy del cliente.
  if (session.user.role === "CLIENT") {
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
            clientName: access.client.name,
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

  return NextResponse.json({ invoiceId: invoice.id, filename });
}
