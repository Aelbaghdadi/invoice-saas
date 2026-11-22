"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { createUploadBatch } from "@/lib/uploadBatches";

const WRONG_PERIOD = "El periodo no vale. Recarga la página.";
const clientIdSchema = z.string({ error: "Elige un cliente." }).trim().min(1, "Elige un cliente.").max(64, "Elige un cliente.");

const startInput = z
  .object({
    clientId: clientIdSchema.nullable(),
    candidateClientIds: z.array(clientIdSchema).max(200, "Como mucho 200 empresas entre las que clasificar.").default([]),
    periodType: z.enum(["MONTHLY", "QUARTERLY"], { error: "Elige mensual o trimestral." }),
    periodMonth: z.number({ error: WRONG_PERIOD }).int(WRONG_PERIOD).min(1, WRONG_PERIOD).max(12, WRONG_PERIOD),
    periodYear: z.number({ error: WRONG_PERIOD }).int(WRONG_PERIOD).min(2000, WRONG_PERIOD).max(2100, WRONG_PERIOD),
    invoiceType: z.enum(["PURCHASE", "SALE", "UNKNOWN"], { error: "Elige el tipo de las facturas." }),
    fileCount: z.number({ error: "La subida no tiene ficheros." }).int("La subida no tiene ficheros."),
    // El taco entero no pasa por aquí: se crea al subir su PDF.
    kind: z.enum(["DIGITAL", "PER_INVOICE"], { error: "La subida no vale. Recarga la página." }),
  })
  .refine((input) => (input.clientId ? input.candidateClientIds.length === 0 : input.candidateClientIds.length > 0), {
    message: "Elige un cliente o las empresas entre las que clasificar.",
  });

/**
 * Empieza la tanda de un «Subir» del gestor (B-R2): digital o taco de factura
 * a factura, antes de subir ningún fichero. Nunca lanza.
 */
export async function startUploadBatch(
  input: unknown,
): Promise<{ ok: true; batchId: string; tacoNumber: number | null } | { error: string }> {
  const parsed = startInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  try {
    const session = await auth();
    if (!session?.user) return { error: "Tu sesión ha caducado. Vuelve a iniciar sesión." };
    const result = await createUploadBatch(session, parsed.data);
    if (!result.ok) return { error: result.error };
    return { ok: true, batchId: result.batch.id, tacoNumber: result.batch.tacoNumber };
  } catch (err) {
    console.error("[tandas] no se ha podido empezar la subida:", err);
    return { error: "No se ha podido empezar la subida. Inténtalo de nuevo." };
  }
}
