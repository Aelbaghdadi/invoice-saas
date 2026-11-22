"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { archiveScope, canAccessArchiveInvoice, canAccessUploadBatch, tacoViewer } from "@/lib/archiveAccess";
import {
  boxProposalForClientYear,
  boxProposalForTaco,
  convertToTaco,
  extendTaco,
  fileTaco,
  placePaper,
  PLACE_PAPER_MAX_SELECTED,
  previewPlacePaper,
  voidTaco,
  type BoxProposal,
  type ConvertedTaco,
  type ExtendedTaco,
  type FiledTaco,
  type PlaceCount,
  type PlacedPaper,
  type PlaceTarget,
  type TacoEditResult,
  type VoidedTaco,
} from "@/lib/tacos";
import { UPLOAD_BATCH_MAX_FILES } from "@/lib/uploadBatches";

const NOT_AUTHORIZED = "No autorizado";
const NO_TACO_ACCESS = "No tienes acceso a este taco.";
const NO_INVOICE_ACCESS = "No tienes acceso a estas facturas.";
const SAVE_FAILED = "No se ha podido guardar. Inténtalo de nuevo.";
const INVALID = "Datos no válidos.";

const id = z.string({ error: INVALID }).trim().min(1, INVALID).max(64, INVALID);
const batchId = id;
const boxLabel = z.string({ error: "Escribe la caja." }).max(200, "La etiqueta de la caja tiene que tener entre 2 y 80 caracteres.");

const boxDestination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), label: boxLabel }).strict(),
  z.object({ kind: z.literal("newBox") }).strict(),
  z.object({ kind: z.literal("returned") }).strict(),
], { error: "Elige dónde va el papel." });

const placeDestination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), label: boxLabel }).strict(),
  z.object({ kind: z.literal("newBox") }).strict(),
  z.object({ kind: z.literal("returned") }).strict(),
  z.object({ kind: z.literal("client") }).strict(),
], { error: "Elige dónde va el papel." });

const fiscalYear = z.number({ error: INVALID }).int(INVALID).min(2000, INVALID).max(2100, INVALID);

// Tres maneras de elegir, cada una con su forma exacta: «Sacar del taco» es
// siempre una sola factura (nunca una selección).
const placeTarget = z.union([
  z.object({
    invoiceIds: z
      .array(id)
      .min(1, "Elige alguna factura.")
      .max(PLACE_PAPER_MAX_SELECTED, `Como mucho ${PLACE_PAPER_MAX_SELECTED} facturas a la vez.`),
  }).strict(),
  z.object({ clientId: id, fiscalYear, includeUnconfirmed: z.boolean({ error: INVALID }) }).strict(),
  z.object({ moveInvoiceId: id }).strict(),
], { error: "Elige las facturas." });

const fileInput = z.object({ batchId, destination: boxDestination });
const batchInput = z.object({ batchId });
const previewInput = z.object({ target: placeTarget });
const placeInput = z.object({ target: placeTarget, destination: placeDestination });
const voidInput = z.object({
  batchId,
  reason: z.string({ error: "Escribe por qué lo anulas (entre 2 y 200 caracteres)." })
    .max(400, "Escribe por qué lo anulas (entre 2 y 200 caracteres)."),
});
const extendInput = z.object({
  batchId,
  expectedFileCount: z.number({ error: INVALID }).int(INVALID).min(0, INVALID).max(UPLOAD_BATCH_MAX_FILES, INVALID),
  addCount: z
    .number({ error: INVALID })
    .int(INVALID)
    .min(1, "Elige algún fichero.")
    .max(UPLOAD_BATCH_MAX_FILES, `Como mucho ${UPLOAD_BATCH_MAX_FILES} páginas por taco.`),
});
const clientYearInput = z.object({ clientId: id, fiscalYear });

type Editor = { firmId: string; userId: string; user: { id: string; role: string; advisoryFirmId: string } };

/** ADMIN o WORKER de una asesoría. */
async function tacoEditor(): Promise<Editor | { error: string }> {
  const session = await auth();
  const user = session?.user;
  if (!user || (user.role !== "ADMIN" && user.role !== "WORKER") || !user.advisoryFirmId) return { error: NOT_AUTHORIZED };
  return { firmId: user.advisoryFirmId, userId: user.id, user: { id: user.id, role: user.role, advisoryFirmId: user.advisoryFirmId } };
}

/** ADMIN o WORKER que ve el taco (B-R20: una sola definición). */
async function tacoEditorFor(batch: string): Promise<Editor | { error: string }> {
  const editor = await tacoEditor();
  if ("error" in editor) return editor;
  if (!(await canAccessUploadBatch({ user: editor.user }, batch))) return { error: NO_TACO_ACCESS };
  return editor;
}

/** ADMIN o WORKER con acceso a las facturas de la elección (como archiveEditor)
 *  o, en «a todas», al cliente. */
async function placeEditor(target: PlaceTarget): Promise<Editor | { error: string }> {
  const editor = await tacoEditor();
  if ("error" in editor) return editor;
  if ("clientId" in target) {
    const scope = await archiveScope({ user: editor.user });
    if (!scope?.clientIds.includes(target.clientId)) return { error: NO_INVOICE_ACCESS };
    return editor;
  }
  const ids = "moveInvoiceId" in target ? [target.moveInvoiceId] : [...new Set(target.invoiceIds)];
  const allowed = await Promise.all(ids.map((invoiceId) => canAccessArchiveInvoice({ user: editor.user }, invoiceId)));
  if (allowed.some((ok) => !ok)) return { error: NO_INVOICE_ACCESS };
  return editor;
}

function revalidateTacos() {
  revalidatePath("/dashboard/archivo");
  revalidatePath("/dashboard/archivo/tacos");
  revalidatePath("/dashboard/archivo/tandas/[id]", "page");
  revalidatePath("/dashboard/archivo/facturas/[id]", "page");
  revalidatePath("/imprimir/taco/[id]", "page");
  revalidatePath("/dashboard/admin/clients/[id]", "page");
  revalidatePath("/dashboard/worker/clients/[id]", "page");
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? INVALID;
}

/** Comprueba quién edita y hace la edición. Todo dentro del try: un fallo de
 *  la BD al comprobar el acceso también acaba en { error } y no sube a la UI. */
async function runTacoAction<T extends object>(
  label: string,
  check: () => Promise<Editor | { error: string }>,
  edit: (editor: Editor) => Promise<TacoEditResult<T>>,
): Promise<TacoEditResult<T>> {
  try {
    const editor = await check();
    if ("error" in editor) return { error: editor.error };
    const result = await edit(editor);
    if ("ok" in result) revalidateTacos();
    return result;
  } catch (err) {
    console.error(`[tacos] no se ha podido ${label}:`, err);
    return { error: SAVE_FAILED };
  }
}

/** «Guardar en caja», «Cambiar de caja» o «Devuelto al cliente» (B-R10). */
export async function fileTacoAction(input: unknown): Promise<TacoEditResult<FiledTaco>> {
  const parsed = fileInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { batchId: id, destination } = parsed.data;
  return runTacoAction("guardar el taco", () => tacoEditorFor(id), (editor) =>
    fileTaco({ firmId: editor.firmId, userId: editor.userId, batchId: id, destination }));
}

/** «Era papel: crear taco» (B-R15). */
export async function convertToTacoAction(input: unknown): Promise<TacoEditResult<ConvertedTaco>> {
  const parsed = batchInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { batchId: id } = parsed.data;
  return runTacoAction("crear el taco", () => tacoEditorFor(id), (editor) =>
    convertToTaco({ firmId: editor.firmId, userId: editor.userId, batchId: id }));
}

/** Cuántas se ubicarán con «Poner ubicación» (sin cambiar nada). */
export async function previewPlacePaperAction(input: unknown): Promise<TacoEditResult<PlaceCount>> {
  const parsed = previewInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { target } = parsed.data;
  try {
    const editor = await placeEditor(target);
    if ("error" in editor) return { error: editor.error };
    return await previewPlacePaper({ firmId: editor.firmId, target });
  } catch (err) {
    console.error("[tacos] no se ha podido contar lo que se ubica:", err);
    return { error: "No se ha podido contar. Inténtalo de nuevo." };
  }
}

/** «Poner ubicación» o «Sacar del taco» (B-R14). */
export async function placePaperAction(input: unknown): Promise<TacoEditResult<PlacedPaper>> {
  const parsed = placeInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { target, destination } = parsed.data;
  return runTacoAction("poner la ubicación", () => placeEditor(target), (editor) =>
    placePaper({ firmId: editor.firmId, userId: editor.userId, target, destination }));
}

/** «Anular el taco…» (B-R22). */
export async function voidTacoAction(input: unknown): Promise<TacoEditResult<VoidedTaco>> {
  const parsed = voidInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { batchId: id, reason } = parsed.data;
  return runTacoAction("anular el taco", () => tacoEditorFor(id), (editor) =>
    voidTaco({ firmId: editor.firmId, userId: editor.userId, batchId: id, reason }));
}

/** «Completar el taco»: hace sitio al final antes de subir (B-R23). */
export async function extendTacoAction(input: unknown): Promise<TacoEditResult<ExtendedTaco>> {
  const parsed = extendInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { batchId: id, expectedFileCount, addCount } = parsed.data;
  return runTacoAction("completar el taco", () => tacoEditorFor(id), (editor) =>
    extendTaco({ firmId: editor.firmId, userId: editor.userId, batchId: id, expectedFileCount, addCount }));
}

/** La caja que se propone al guardar un taco (5.4). */
export async function boxProposalAction(input: unknown): Promise<TacoEditResult<{ proposal: BoxProposal }>> {
  const parsed = batchId.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    const editor = await tacoEditorFor(parsed.data);
    if ("error" in editor) return { error: editor.error };
    const viewer = await tacoViewer({ user: editor.user });
    if (!viewer) return { error: NO_TACO_ACCESS };
    const proposal = await boxProposalForTaco(viewer, parsed.data);
    return proposal ? { ok: true, proposal } : { error: "No se ha encontrado el taco. Recarga la página." };
  } catch (err) {
    console.error("[tacos] no se ha podido proponer la caja:", err);
    return { error: "No se ha podido proponer la caja. Escríbela." };
  }
}

/** La caja que se propone al poner ubicación al papel de un cliente y ejercicio (5.11). */
export async function placePaperProposalAction(input: unknown): Promise<TacoEditResult<{ proposal: BoxProposal }>> {
  const parsed = clientYearInput.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  try {
    const editor = await tacoEditor();
    if ("error" in editor) return { error: editor.error };
    const viewer = await tacoViewer({ user: editor.user });
    if (!viewer?.clientIds.includes(parsed.data.clientId)) return { error: NO_INVOICE_ACCESS };
    const proposal = await boxProposalForClientYear(viewer, parsed.data.clientId, parsed.data.fiscalYear);
    return proposal ? { ok: true, proposal } : { error: "No se ha encontrado el cliente. Recarga la página." };
  } catch (err) {
    console.error("[tacos] no se ha podido proponer la caja:", err);
    return { error: "No se ha podido proponer la caja. Escríbela." };
  }
}
