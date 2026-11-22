"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { canAccessUploadBatch } from "@/lib/archiveAccess";
import { processInvoice } from "@/lib/processInvoice";
import { splitWholeTaco, TACO_SPLIT_FAILED_ERROR } from "@/lib/tacoSplit";
import { TACO_PDF_MAX_PAGES, TACO_SPLIT_MAX_PARTS } from "@/lib/tacoSplitPlan";

const MARKS_INVALID = "Las marcas no valen. Recarga la página.";

const splitInput = z.object({
  batchId: z.string({ error: MARKS_INVALID }).trim().min(1, MARKS_INVALID).max(64, MARKS_INVALID),
  startPages: z
    .array(z.number({ error: MARKS_INVALID }).int(MARKS_INVALID).min(1, MARKS_INVALID).max(TACO_PDF_MAX_PAGES, MARKS_INVALID), {
      error: MARKS_INVALID,
    })
    .min(1, "Marca al menos dónde empieza una factura.")
    .max(TACO_SPLIT_MAX_PARTS, `Como mucho ${TACO_SPLIT_MAX_PARTS} facturas por taco.`),
});

export type SplitWholeTacoResult = { ok: true; invoiceCount: number } | { error: string };

/**
 * «Crear las facturas» de un taco entero (B-R9): una por cada página marcada.
 * ADMIN o WORKER que ve el taco (B-R20). Cada factura va a la cola del OCR en
 * su propio after(), como cada fichero de /api/uploads. Nunca lanza.
 */
export async function splitWholeTacoAction(input: unknown): Promise<SplitWholeTacoResult> {
  const parsed = splitInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? MARKS_INVALID };
  const { batchId, startPages } = parsed.data;
  try {
    const session = await auth();
    const user = session?.user;
    if (!user || (user.role !== "ADMIN" && user.role !== "WORKER") || !user.advisoryFirmId) {
      return { error: "No autorizado" };
    }
    if (!(await canAccessUploadBatch({ user }, batchId))) return { error: "No tienes acceso a este taco." };

    const result = await splitWholeTaco({ firmId: user.advisoryFirmId, userId: user.id, batchId, startPages });
    if ("error" in result) return result;

    const userId = user.id;
    for (const invoiceId of result.invoiceIds) {
      after(async () => {
        await processInvoice(invoiceId, userId).catch((err) => {
          console.error(`[taco entero/processInvoice] ${invoiceId} falló:`, err);
        });
      });
    }

    revalidatePath(`/dashboard/archivo/tandas/${batchId}`);
    revalidatePath("/dashboard/archivo/tacos");
    revalidatePath("/dashboard/archivo");
    revalidatePath("/imprimir/taco/[id]", "page");
    revalidatePath("/dashboard/worker");
    revalidatePath("/dashboard/admin");
    revalidatePath("/dashboard/worker/invoices");
    revalidatePath("/dashboard/worker/batch", "layout");
    revalidatePath("/dashboard/admin/batch", "layout");
    return { ok: true, invoiceCount: result.invoiceIds.length };
  } catch (err) {
    console.error(`[taco entero] ${batchId}: no se ha podido dividir:`, err);
    return { error: TACO_SPLIT_FAILED_ERROR };
  }
}
