"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { canAccessArchiveInvoice } from "@/lib/archiveAccess";
import {
  ARCHIVE_EDIT_MAX_INVOICES,
  attachOriginalDocument,
  removeOriginalDocument,
  setOriginalMedium,
  setRetentionHold,
  type ArchiveEditResult,
} from "@/lib/archiveEdits";
import { ERROR_MESSAGES } from "@/lib/errorCodes";
import { ORIGINAL_ATTACHMENT_MAX_BYTES } from "@/lib/fileValidation";

export type ArchiveActionResult = { error: string } | { ok: true; changed: number };

const NO_ACCESS = "No tienes acceso a estas facturas.";
const SAVE_FAILED = "No se ha podido guardar. Inténtalo de nuevo.";

const invoiceIds = z
  .array(z.string().trim().min(1).max(64))
  .min(1, "Elige alguna factura.")
  .max(ARCHIVE_EDIT_MAX_INVOICES, `Como mucho ${ARCHIVE_EDIT_MAX_INVOICES} facturas a la vez.`);

const mediumInput = z.object({
  invoiceIds,
  // «Por confirmar» es el medio vacío, puesto a mano (anexo C2).
  medium: z.enum(["ELECTRONIC", "PAPER", "UNCONFIRMED"], { error: "Elige electrónico, papel o por confirmar." }),
});

const retentionInput = z
  .object({
    invoiceIds,
    hold: z.boolean(),
    reason: z.enum(["FIXED_ASSET", "TAX_CREDITS", "INSPECTION", "OTHER"]).nullish(),
    note: z.string().max(500, "La nota no puede pasar de 500 caracteres.").nullish(),
  })
  .refine((input) => !input.hold || input.reason, { message: "Elige por qué hay que conservarlas más.", path: ["reason"] });

const invoiceId = z.string().trim().min(1, "Falta la factura.").max(64);

const attachInput = z.object({
  invoiceId,
  file: z
    .instanceof(File, { error: "Elige el fichero del original." })
    .refine((file) => file.size > 0, "El fichero está vacío.")
    .refine((file) => file.size <= ORIGINAL_ATTACHMENT_MAX_BYTES, ERROR_MESSAGES["ERR-ARCHIVE-001"]),
});

type Editor = { firmId: string; userId: string };

/** Quien edita: ADMIN o WORKER con acceso a todas las facturas (R22). */
async function archiveEditor(ids: readonly string[]): Promise<Editor | { error: string }> {
  const session = await auth();
  const user = session?.user;
  if (!user || (user.role !== "ADMIN" && user.role !== "WORKER") || !user.advisoryFirmId) return { error: "No autorizado" };
  const allowed = await Promise.all([...new Set(ids)].map((id) => canAccessArchiveInvoice({ user }, id)));
  if (allowed.some((ok) => !ok)) return { error: NO_ACCESS };
  return { firmId: user.advisoryFirmId, userId: user.id };
}

function revalidateArchive(clientId: string) {
  revalidatePath("/dashboard/archivo");
  revalidatePath("/dashboard/archivo/facturas/[id]", "page");
  revalidatePath(`/dashboard/admin/clients/${clientId}`);
  revalidatePath(`/dashboard/worker/clients/${clientId}`);
}

/** Comprueba quién edita y hace la edición. Todo dentro del try: un fallo de la
 *  BD al comprobar el acceso también acaba en { error } y no sube a la UI. */
async function runEdit(
  label: string,
  ids: readonly string[],
  edit: (editor: Editor) => Promise<ArchiveEditResult>,
): Promise<ArchiveActionResult> {
  try {
    const editor = await archiveEditor(ids);
    if ("error" in editor) return editor;
    const result = await edit(editor);
    if ("error" in result) return { error: result.error };
    revalidateArchive(result.clientId);
    return { ok: true, changed: result.changed };
  } catch (err) {
    console.error(`[archivo] no se ha podido ${label}:`, err);
    return { error: SAVE_FAILED };
  }
}

/** Electrónico, papel o «Por confirmar», a mano, de una factura (y su
 *  división) o de varias del mismo cliente. */
export async function setOriginalMediumAction(input: unknown): Promise<ArchiveActionResult> {
  const parsed = mediumInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  const { medium } = parsed.data;
  return runEdit("cambiar electrónico o papel", parsed.data.invoiceIds, (editor) => setOriginalMedium({
    ...editor,
    invoiceIds: parsed.data.invoiceIds,
    medium: medium === "UNCONFIRMED" ? null : medium,
  }));
}

/** «Conservar más» (con motivo y nota) o quitarlo, de una factura o de varias
 *  del mismo cliente. */
export async function setRetentionHoldAction(input: unknown): Promise<ArchiveActionResult> {
  const parsed = retentionInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  const { hold, reason, note } = parsed.data;
  return runEdit("cambiar «conservar más»", parsed.data.invoiceIds, (editor) => setRetentionHold({
    ...editor,
    invoiceIds: parsed.data.invoiceIds,
    hold,
    reason: reason ?? null,
    note: note ?? null,
  }));
}

/** Adjunta el original en Word, Excel, OpenDocument o RTF de una factura
 *  (formulario con `invoiceId` y `file`). */
export async function attachOriginalDocumentAction(formData: FormData): Promise<ArchiveActionResult> {
  if (!(formData instanceof FormData)) return { error: "Datos no válidos." };
  const parsed = attachInput.safeParse({ invoiceId: formData.get("invoiceId"), file: formData.get("file") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  const { file } = parsed.data;
  return runEdit("adjuntar el original", [parsed.data.invoiceId], async (editor) => attachOriginalDocument({
    ...editor,
    invoiceId: parsed.data.invoiceId,
    file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
  }));
}

/** «Quitar el original adjunto»: el fichero se queda guardado y en el historial. */
export async function removeOriginalDocumentAction(input: unknown): Promise<ArchiveActionResult> {
  const parsed = z.object({ invoiceId }).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  return runEdit("quitar el original adjunto", [parsed.data.invoiceId], (editor) => removeOriginalDocument({ ...editor, invoiceId: parsed.data.invoiceId }));
}
