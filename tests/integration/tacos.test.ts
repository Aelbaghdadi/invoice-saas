// Escrituras de los tacos (entrega B, I3), por las acciones reales de
// /dashboard/archivo/tacoActions: guardar en caja o devolver (B-R10), la caja
// que se propone (B-R11), «Era papel» (B-R15), «Poner ubicación» y «Sacar del
// taco» (B-R14, B-R16), anular (B-R22) y completar (B-R23) un taco, con sus
// bloqueos y conflictos (B-R21). Ninguna toca Invoice.updatedAt.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { InvoiceStatus, OriginalMedium, OriginalMediumSource, UploadBatch } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, makeTaco, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs, type TestSessionUser } from "./helpers/session";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { discardAfterCallbacks } from "./helpers/after";
import { stubOcr } from "./helpers/ocr";
import { DIGITAL_PRODUCER, testPdf } from "./helpers/pdfs";
import { reviewForm, validate } from "./helpers/reviewForm";
import { POST as upload } from "@/app/api/uploads/route";
import {
  boxProposalAction,
  convertToTacoAction,
  extendTacoAction,
  fileTacoAction,
  placePaperAction,
  placePaperProposalAction,
  previewPlacePaperAction,
  voidTacoAction,
} from "@/app/dashboard/archivo/tacoActions";
import { ARCHIVE_EDIT_CONFLICT_ERROR, ARCHIVE_EDIT_WAITS } from "@/lib/archiveEdits";
import { verifyFirmAuditChains } from "@/lib/auditLog";
import { formatDayEs } from "@/lib/dates";
import { tacoSlots } from "@/lib/paperLocation";
import { processInvoice } from "@/lib/processInvoice";
import {
  EXTEND_CONFLICT,
  EXTEND_NOT_A_TACO,
  EXTEND_TOO_MANY,
  EXTEND_WHOLE_PDF,
  MIXED_CLIENTS,
  NOT_IN_A_TACO,
  NOTHING_WITHOUT_LOCATION,
  TACO_VOIDED,
  VOID_ALIVE_INVOICES,
  VOID_ALREADY,
  VOID_ARCHIVE,
  VOID_PAPER_FROM_OUTSIDE,
  VOID_REASON_ERROR,
} from "@/lib/tacos";
import { BOX_LABEL_LENGTH_ERROR } from "@/lib/boxProposal";
import { TACO_LOCK_NAMESPACE } from "@/lib/uploadBatches";
import type { ExtractedInvoice, OcrResult } from "@/lib/ocr";

let a: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
});

const defaultLockTimeout = ARCHIVE_EDIT_WAITS.lockTimeoutMs;
afterEach(() => {
  ARCHIVE_EDIT_WAITS.lockTimeoutMs = defaultLockTimeout;
});

const PREFIX = "Cliente A SL · 2026 · Caja ";
const today = () => formatDayEs(new Date());

async function waitUntil(check: () => Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`tiempo agotado esperando: ${what}`);
}

const waitingForLock = (n: number) => waitUntil(async () => (await sessionsWaitingForLock()) >= n, `${n} sesiones esperando un bloqueo`);

type PaperOptions = {
  medium?: OriginalMedium | null;
  source?: OriginalMediumSource | null;
  reason?: string | null;
  held?: boolean;
  paperBatchId?: string;
  status?: InvoiceStatus;
  splitPart?: number;
  splitFromId?: string;
};

/** Una factura que llegó en `batch`, en su posición; por defecto papel del taco (PAPER/TACO). */
async function arrivedIn(batch: Pick<UploadBatch, "id" | "createdAt">, position: number, options: PaperOptions = {}) {
  const invoice = await makeInvoice(a.client, {
    status: options.status ?? "PENDING_REVIEW",
    ...(options.splitFromId ? { splitFromId: options.splitFromId } : {}),
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: {
      uploadBatchId: batch.id,
      uploadPosition: position,
      splitPart: options.splitPart ?? 0,
      receivedAt: batch.createdAt,
      originalMedium: options.medium === undefined ? "PAPER" : options.medium,
      originalMediumSource: options.source === undefined ? "TACO" : options.source,
      originalMediumReason: options.reason === undefined ? "taco" : options.reason,
      paperHeldByClient: options.held ?? false,
      ...(options.paperBatchId ? { paperBatchId: options.paperBatchId } : {}),
    },
  });
  return invoice;
}

/** Una factura sin tanda, con su medio (papel a mano o «Por confirmar»). */
async function loose(
  medium: OriginalMedium | null,
  options: { status?: InvoiceStatus; client?: { id: string }; periodYear?: number; splitFromId?: string } = {},
) {
  const invoice = await makeInvoice(options.client ?? a.client, {
    status: options.status ?? "VALIDATED",
    ...(options.periodYear ? { periodYear: options.periodYear } : {}),
    ...(options.splitFromId ? { splitFromId: options.splitFromId } : {}),
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    data: medium == null
      ? { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: "scan_unconfirmed" }
      : { originalMedium: medium, originalMediumSource: "MANUAL", originalMediumReason: "manual" },
  });
  return invoice;
}

const archiveOf = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });
const batchOf = (id: string) => prisma.uploadBatch.findUniqueOrThrow({ where: { id } });
const updatedAtOf = async (id: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).updatedAt;

/** Las entradas de auditoría de una factura en el orden de su cadena. */
async function auditsOf(invoiceId: string, field: string) {
  const all = await prisma.auditLog.findMany({ where: { invoiceId }, select: { id: true, prevId: true, field: true, oldValue: true, newValue: true, userId: true } });
  const byPrev = new Map(all.map((entry) => [entry.prevId, entry]));
  const ordered: typeof all = [];
  for (let entry = byPrev.get(null); entry; entry = byPrev.get(entry.id)) ordered.push(entry);
  return ordered.filter((entry) => entry.field === field).map(({ oldValue, newValue, userId }) => ({ oldValue, newValue, userId }));
}
const locationAudits = (invoiceId: string) => auditsOf(invoiceId, "paperLocation");

const as = <T>(user: TestSessionUser, action: () => Promise<T>) => {
  signInAs(user);
  return action();
};

function okOf<T extends object>(result: T | { error: string }): T {
  if ("error" in result) throw new Error(`se esperaba ok y vino: ${result.error}`);
  return result;
}

const ocrReply = (): OcrResult => ({
  rawJson: "{}",
  extracted: {
    issuerName: "Proveedor SL", issuerCif: "B12345674", receiverName: a.client.name, receiverCif: a.client.cif,
    invoiceNumber: "F-1", invoiceDate: "2026-09-10", taxBase: 100, vatRate: 21, vatAmount: 21,
    irpfRate: null, irpfAmount: null, totalAmount: 121, currency: "EUR", supplyType: null,
    vatLines: [{ taxBase: 100, vatRate: 21, vatAmount: 21 }], confidence: null,
  } as ExtractedInvoice,
});

let fileSequence = 0;
/** Una factura en UPLOADED con su PDF de verdad en el S3 falso, llegada en `batch`. */
async function uploadedIn(batch: Pick<UploadBatch, "id" | "createdAt">, position: number, body: Buffer) {
  const key = `${a.client.id}/2026-09/tacos-${++fileSequence}.pdf`;
  fakeS3().put(key, body);
  const invoice = await makeInvoice(a.client, {
    filename: `escaneo-${fileSequence}.pdf`, storageKey: key, fileType: "application/pdf", status: "UPLOADED",
    invoiceNumber: null, invoiceDate: null, issuerName: null, issuerCif: null,
    taxBase: null, vatRate: null, vatAmount: null, totalAmount: null,
  });
  await prisma.invoiceArchive.update({
    where: { invoiceId: invoice.id },
    // Como /api/uploads con un PDF: el medio lo propone el análisis.
    data: { uploadBatchId: batch.id, uploadPosition: position, receivedAt: batch.createdAt },
  });
  return invoice;
}

/** POST /api/uploads al lote de septiembre de 2026 de compras del cliente de A. */
async function post(user: TestSessionUser, bytes: Buffer, batch: { id: string; position: number }) {
  signInAs(user);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "escaneo.pdf", { type: "application/pdf" }));
  form.set("clientId", a.client.id);
  form.set("periodType", "MONTHLY");
  form.set("periodMonth", "9");
  form.set("periodYear", "2026");
  form.set("type", "PURCHASE");
  form.set("uploadBatchId", batch.id);
  form.set("uploadPosition", String(batch.position));
  const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
  discardAfterCallbacks();
  return { status: res.status, body: await res.json() };
}

let pdfSequence = 0;
async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setTitle(`taco-${++pdfSequence}`);
  return Buffer.from(await doc.save());
}

// ── 1-4. Guardar en caja o devolver (B-R10) ─────────────────────────────────

describe("guardar en caja o devolver (B-R10)", () => {
  it("guarda en una caja y audita la ubicación de cada factura de papel del taco, y nada más", async () => {
    const taco = await makeTaco(a, { fileCount: 5 });
    const other = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Caja del sótano" } });
    const p1 = await arrivedIn(taco, 1);
    const p2 = await arrivedIn(taco, 2);
    const electronic = await arrivedIn(taco, 3, { medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text" });
    const held = await arrivedIn(taco, 4, { held: true });
    const elsewhere = await arrivedIn(taco, 5, { paperBatchId: other.id });
    const before = await updatedAtOf(p2.id);

    const result = okOf(await as(a.worker, () => fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `  ${PREFIX}1 ` } })));
    expect(result).toMatchObject({ tacoNumber: taco.tacoNumber, boxLabel: `${PREFIX}1`, locationText: `${PREFIX}1` });
    expect(await batchOf(taco.id)).toMatchObject({ boxLabel: `${PREFIX}1`, returnedAt: null, filedById: a.worker.id });
    expect((await batchOf(taco.id)).filedAt).not.toBeNull();

    expect(await locationAudits(p2.id)).toEqual([
      { oldValue: `Taco ${taco.tacoNumber} · Pág. 2 (sin guardar)`, newValue: `${PREFIX}1 · Taco ${taco.tacoNumber} · Pág. 2`, userId: a.worker.id },
    ]);
    expect(await locationAudits(p1.id)).toHaveLength(1);
    for (const untouched of [electronic, held, elsewhere]) expect(await locationAudits(untouched.id)).toEqual([]);
    expect(await updatedAtOf(p2.id)).toEqual(before);
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("cambiar de caja deja otra entrada; devolverlo quita la caja y pone la fecha de hoy", async () => {
    const taco = await makeTaco(a);
    const p1 = await arrivedIn(taco, 1);
    signInAs(a.admin);
    okOf(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}1` } }));
    okOf(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}2` } }));
    const returned = okOf(await fileTacoAction({ batchId: taco.id, destination: { kind: "returned" } }));
    expect(returned).toMatchObject({ boxLabel: null, locationText: `Devuelto al cliente el ${today()}` });
    const batch = await batchOf(taco.id);
    expect(batch.boxLabel).toBeNull();
    expect(batch.returnedAt).not.toBeNull();
    expect(formatDayEs(batch.returnedAt)).toBe(today());
    expect((await locationAudits(p1.id)).map((entry) => entry.newValue)).toEqual([
      `${PREFIX}1 · Taco ${taco.tacoNumber} · Pág. 1`,
      `${PREFIX}2 · Taco ${taco.tacoNumber} · Pág. 1`,
      `Devuelto al cliente el ${today()} · Taco ${taco.tacoNumber} · Pág. 1`,
    ]);
  });

  it("dos guardados a la vez se aplican en orden: el «antes» del segundo es el «después» del primero", async () => {
    const taco = await makeTaco(a);
    const p1 = await arrivedIn(taco, 1);
    const lock = await holdLock(`SELECT 1 FROM "UploadBatch" WHERE "id" = $1 FOR UPDATE`, taco.id);
    signInAs(a.worker);
    const first = inFlight(fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}1` } }));
    await waitingForLock(1);
    const second = inFlight(fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}2` } }));
    await waitingForLock(2);
    await lock.release();
    const results = await Promise.all([first, second]);
    for (const result of results) okOf(result);

    const entries = await locationAudits(p1.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].oldValue).toBe(`Taco ${taco.tacoNumber} · Pág. 1 (sin guardar)`);
    expect(entries[1].oldValue).toBe(entries[0].newValue);
    expect(`${(await batchOf(taco.id)).boxLabel} · Taco ${taco.tacoNumber} · Pág. 1`).toBe(entries[1].newValue);
  });

  it("con la tanda retenida más que el lock_timeout: «Otra persona…» y sin cambios", async () => {
    ARCHIVE_EDIT_WAITS.lockTimeoutMs = 300;
    const taco = await makeTaco(a);
    await arrivedIn(taco, 1);
    const lock = await holdLock(`SELECT 1 FROM "UploadBatch" WHERE "id" = $1 FOR UPDATE`, taco.id);
    try {
      expect(await as(a.worker, () => fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}1` } })))
        .toEqual({ error: ARCHIVE_EDIT_CONFLICT_ERROR });
    } finally {
      await lock.release();
    }
    expect(await batchOf(taco.id)).toMatchObject({ boxLabel: null, filedAt: null });
  });

  it("etiquetas de 1 y de 81 caracteres no; un taco vacío y uno entero sin dividir se guardan sin auditoría; uno anulado no", async () => {
    const taco = await makeTaco(a);
    signInAs(a.worker);
    expect(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: "A" } })).toEqual({ error: BOX_LABEL_LENGTH_ERROR });
    expect(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: "x".repeat(81) } })).toEqual({ error: BOX_LABEL_LENGTH_ERROR });
    expect((await batchOf(taco.id)).filedAt).toBeNull();

    okOf(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: "Caja 1" } }));
    const whole = await makeTaco(a, { wholePdf: { pageCount: 12 } });
    okOf(await fileTacoAction({ batchId: whole.id, destination: { kind: "box", label: "Caja 1" } }));
    expect(await batchOf(whole.id)).toMatchObject({ boxLabel: "Caja 1", pdfSplitAt: null });
    expect(await prisma.auditLog.count({ where: { field: "paperLocation" } })).toBe(0);

    const voided = await makeTaco(a, { voided: { reason: "Subido por error" } });
    expect(await fileTacoAction({ batchId: voided.id, destination: { kind: "returned" } })).toEqual({ error: TACO_VOIDED });
  });

  it("acceso: sin el cliente (aunque lo creara), otra asesoría y el portal no; en uno de varios, quien lo subió y quien tiene un candidato, sí", async () => {
    const b = await makeFirm("B");
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    const creatorWithoutClient = await makeUser(a.firm.id, "WORKER", "gestorquesubio");
    const taco = await makeTaco(a, { createdById: creatorWithoutClient.id });
    const destination = { kind: "box", label: "Caja 1" };
    for (const user of [stranger, creatorWithoutClient, b.admin, b.worker]) {
      expect(await as(user, () => fileTacoAction({ batchId: taco.id, destination }))).toEqual({ error: "No tienes acceso a este taco." });
    }
    expect(await as(a.clientUser, () => fileTacoAction({ batchId: taco.id, destination }))).toEqual({ error: "No autorizado" });
    expect((await batchOf(taco.id)).filedAt).toBeNull();

    const several = await makeTaco(a, { clientId: null, candidateIds: [a.client.id], createdById: stranger.id });
    const byCreator = okOf(await as(stranger, () => fileTacoAction({ batchId: several.id, destination: { kind: "newBox" } })));
    expect(byCreator.boxLabel).toBe("Varios clientes · 2026 · Caja 2");
    okOf(await as(a.worker, () => fileTacoAction({ batchId: several.id, destination: { kind: "returned" } })));
  });
});

// ── 6-7. La caja que se propone (B-R11) y «Caja nueva» ──────────────────────

describe("la caja que se propone (B-R11)", () => {
  const proposalOf = async (user: TestSessionUser, batchId: string) =>
    okOf(await as(user, () => boxProposalAction(batchId))).proposal;
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 10));

  it("una caja por cliente y año: sin tacos la 1; con «… Caja 3» esa y la nueva la 4; otro cliente, otro ejercicio y los anulados no cuentan; un ARCHIVE del ámbito sí", async () => {
    const taco = await makeTaco(a);
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({
      mode: "PER_CLIENT_YEAR", proposed: `${PREFIX}1`, next: `${PREFIX}2`, lastUsed: null, clientName: "Cliente A SL", fiscalYearLabel: "2026",
    });

    await makeTaco(a, { filed: { boxLabel: `${PREFIX}3`, at: at(1) } });
    const client2 = await prisma.client.create({ data: { name: "Cliente Dos SL", cif: "B55443322", advisoryFirmId: a.firm.id } });
    await makeTaco(a, { clientId: client2.id, filed: { boxLabel: "Cliente Dos SL · 2026 · Caja 9", at: at(5) } });
    await makeTaco(a, { period: { periodType: "MONTHLY", periodMonth: 9, periodYear: 2025 }, filed: { boxLabel: "Cliente A SL · 2025 · Caja 7", at: at(6) } });
    await makeTaco(a, { filed: { boxLabel: `${PREFIX}8`, at: at(7) }, voided: { reason: "Subido por error" } });
    const b = await makeFirm("B");
    await makeTaco(b, { filed: { boxLabel: `${PREFIX}20`, at: at(8) } });
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({ proposed: `${PREFIX}3`, next: `${PREFIX}4`, lastUsed: `${PREFIX}3` });

    // El papel ubicado a mano del mismo cliente y ejercicio cuenta (y es el más reciente).
    await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: `${PREFIX}5`, at: at(9) } });
    const proposal = await proposalOf(a.worker, taco.id);
    expect(proposal).toMatchObject({ proposed: `${PREFIX}5`, next: `${PREFIX}6` });
    expect(proposal.suggestions.slice(0, 2)).toEqual([`${PREFIX}5`, `${PREFIX}3`]);
    expect(proposal.suggestions).not.toContain(`${PREFIX}8`);
    expect(proposal.suggestions).not.toContain(`${PREFIX}20`);
    // Las cajas de un cliente que el gestor no tiene no se le sugieren (llevan su nombre); al administrador, sí.
    expect(proposal.suggestions).not.toContain("Cliente Dos SL · 2026 · Caja 9");
    expect((await proposalOf(a.admin, taco.id)).suggestions).toContain("Cliente Dos SL · 2026 · Caja 9");
    expect(okOf(await as(a.worker, () => placePaperProposalAction({ clientId: a.client.id, fiscalYear: 2026 }))).proposal.suggestions)
      .not.toContain("Cliente Dos SL · 2026 · Caja 9");
  });

  it("todas juntas: la última de la asesoría; la otra asesoría nunca", async () => {
    await prisma.advisoryFirm.update({ where: { id: a.firm.id }, data: { paperBoxMode: "SHARED" } });
    const taco = await makeTaco(a);
    await makeTaco(a, { filed: { boxLabel: "Caja 4", at: at(1) } });
    await makeTaco(a, { filed: { boxLabel: "Caja 12", at: at(3) } });
    const b = await makeFirm("B");
    await makeTaco(b, { filed: { boxLabel: "Caja 40", at: at(9) } });
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({ mode: "SHARED", proposed: "Caja 12", next: "Caja 13" });
  });

  it("todas juntas: la última caja es la de la asesoría aunque sea de otro cliente y de otro ejercicio; «Caja nueva», la siguiente", async () => {
    await prisma.advisoryFirm.update({ where: { id: a.firm.id }, data: { paperBoxMode: "SHARED" } });
    const other = await prisma.client.create({ data: { name: "Clínica Secreta SL", cif: "B99887766", advisoryFirmId: a.firm.id } });
    const taco = await makeTaco(a);
    await makeTaco(a, { filed: { boxLabel: "Caja 4", at: at(1) } });
    await makeTaco(a, {
      clientId: other.id,
      period: { periodType: "MONTHLY", periodMonth: 3, periodYear: 2025 },
      filed: { boxLabel: "Caja 12", at: at(3) },
    });
    // Escrita a mano en un taco de ese cliente: cuenta para nada en este modo y no se le enseña al gestor.
    await makeTaco(a, { clientId: other.id, filed: { boxLabel: "Clínica Secreta SL · 2026 · Caja 7", at: at(2) } });

    for (const user of [a.worker, a.admin]) {
      expect(await proposalOf(user, taco.id)).toMatchObject({ proposed: "Caja 12", next: "Caja 13", lastUsed: "Caja 12" });
      expect(okOf(await as(user, () => placePaperProposalAction({ clientId: a.client.id, fiscalYear: 2026 }))).proposal)
        .toMatchObject({ proposed: "Caja 12", next: "Caja 13" });
    }
    const forWorker = await proposalOf(a.worker, taco.id);
    expect(forWorker.suggestions).toEqual(["Caja 4"]);
    expect((await proposalOf(a.admin, taco.id)).suggestions).toEqual(["Caja 12", "Caja 4", "Clínica Secreta SL · 2026 · Caja 7"]);

    expect(okOf(await as(a.worker, () => fileTacoAction({ batchId: taco.id, destination: { kind: "newBox" } }))).boxLabel).toBe("Caja 13");
  });

  it("con el ejercicio de julio a junio, «2025-26»; para un cliente y ejercicio, lo mismo", async () => {
    const july = await prisma.client.create({
      data: { name: "Cliente Julio SL", cif: "B11223344", advisoryFirmId: a.firm.id, fiscalYearStartMonth: 7 },
    });
    await prisma.workerClientAssignment.create({ data: { workerId: a.worker.id, clientId: july.id } });
    const taco = await makeTaco(a, { clientId: july.id, period: { periodType: "MONTHLY", periodMonth: 3, periodYear: 2026 } });
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({ proposed: "Cliente Julio SL · 2025-26 · Caja 1", fiscalYearLabel: "2025-26" });
    expect(okOf(await as(a.worker, () => placePaperProposalAction({ clientId: july.id, fiscalYear: 2025 }))).proposal)
      .toMatchObject({ proposed: "Cliente Julio SL · 2025-26 · Caja 1", next: "Cliente Julio SL · 2025-26 · Caja 2" });
  });

  it("al cambiar el ajuste solo cuentan las cajas del modo nuevo (en los dos sentidos)", async () => {
    const taco = await makeTaco(a);
    await makeTaco(a, { filed: { boxLabel: "Caja 12", at: at(2) } });
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({ proposed: `${PREFIX}1`, next: `${PREFIX}2` });
    await prisma.advisoryFirm.update({ where: { id: a.firm.id }, data: { paperBoxMode: "SHARED" } });
    expect(await proposalOf(a.worker, taco.id)).toMatchObject({ proposed: "Caja 12", next: "Caja 13" });

    // Al revés, en otra asesoría: de una por cliente a todas juntas, «… Caja 3»
    // no cuenta y «Caja nueva» no toma el 3.
    const b = await makeFirm("B");
    const bTaco = await makeTaco(b);
    await makeTaco(b, { filed: { boxLabel: "Cliente B SL · 2026 · Caja 3", at: at(4) } });
    expect(await proposalOf(b.worker, bTaco.id)).toMatchObject({ proposed: "Cliente B SL · 2026 · Caja 3", next: "Cliente B SL · 2026 · Caja 4" });
    await prisma.advisoryFirm.update({ where: { id: b.firm.id }, data: { paperBoxMode: "SHARED" } });
    expect(await proposalOf(b.worker, bTaco.id)).toMatchObject({ proposed: "Caja 1", next: "Caja 2", lastUsed: null });
  });

  it("«Caja nueva» a la vez en el mismo ámbito: dos cajas distintas", async () => {
    await makeTaco(a, { filed: { boxLabel: `${PREFIX}4`, at: at(1) } });
    const t1 = await makeTaco(a);
    const t2 = await makeTaco(a);
    // Con el bloqueo de la asesoría retenido, las dos llegan a la vez a calcular la caja.
    const lock = await holdLock(`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}, hashtext($1))`, a.firm.id);
    signInAs(a.worker);
    const pending = [t1, t2].map((taco) => inFlight(fileTacoAction({ batchId: taco.id, destination: { kind: "newBox" } })));
    await waitingForLock(2);
    await lock.release();
    const results = await Promise.all(pending);
    expect(results.map((result) => okOf(result).boxLabel).sort()).toEqual([`${PREFIX}5`, `${PREFIX}6`]);
  });
});

// ── 8. Era papel: crear taco (B-R15) ────────────────────────────────────────

describe("«Era papel: crear taco» (B-R15)", () => {
  it("le pone el nº siguiente y pasa a papel lo «Por confirmar» (con su división); lo electrónico y lo de papel se quedan", async () => {
    await makeTaco(a, { tacoNumber: 4 });
    const digital = await makeTaco(a, { tacoNumber: null, fileCount: 5 });
    const auto = await arrivedIn(digital, 1, { medium: null, source: "AUTO", reason: "scan_unconfirmed" });
    const manual = await arrivedIn(digital, 2, { medium: null, source: "MANUAL", reason: "manual" });
    const electronic = await arrivedIn(digital, 3, { medium: "ELECTRONIC", source: "AUTO", reason: "pdf_text" });
    const paper = await arrivedIn(digital, 4, { medium: "PAPER", source: "MANUAL", reason: "manual" });
    const root = await arrivedIn(digital, 5, { medium: null, source: "AUTO", reason: "scan_unconfirmed", status: "SPLIT_SOURCE" });
    const part1 = await arrivedIn(digital, 5, { medium: null, source: "AUTO", reason: "split", splitPart: 1, splitFromId: root.id });
    const part2 = await arrivedIn(digital, 5, { medium: null, source: "AUTO", reason: "split", splitPart: 2, splitFromId: root.id });
    const before = await updatedAtOf(auto.id);

    const result = okOf(await as(a.worker, () => convertToTacoAction({ batchId: digital.id })));
    expect(result).toEqual({ ok: true, tacoNumber: 5, converted: 4 });
    expect((await batchOf(digital.id)).tacoNumber).toBe(5);
    for (const invoice of [auto, manual, root, part1, part2]) {
      expect(await archiveOf(invoice.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" });
      expect(await auditsOf(invoice.id, "originalMedium")).toEqual([{ oldValue: null, newValue: "PAPER", userId: a.worker.id }]);
    }
    expect(await archiveOf(electronic.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO" });
    expect(await archiveOf(paper.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL" });
    expect(await locationAudits(auto.id)).toEqual([{ oldValue: "Por confirmar", newValue: "Taco 5 · Pág. 1 (sin guardar)", userId: a.worker.id }]);
    expect(await locationAudits(paper.id)).toEqual([{ oldValue: "Sin ubicación", newValue: "Taco 5 · Pág. 4 (sin guardar)", userId: a.worker.id }]);
    expect(await locationAudits(electronic.id)).toEqual([]);
    expect(await updatedAtOf(auto.id)).toEqual(before);

    expect(await convertToTacoAction({ batchId: digital.id })).toEqual({ error: "Esta tanda ya es el Taco 5." });
    const archived = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Caja 1" } });
    expect(await convertToTacoAction({ batchId: archived.id })).toEqual({ error: "El papel ubicado a mano no se convierte en taco." });
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("una factura que se está analizando al convertir sigue siendo papel del taco cuando el análisis termina", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    const invoice = await uploadedIn(digital, 1, await testPdf({ text: true, producer: DIGITAL_PRODUCER }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubOcr(async () => {
      await gate;
      return ocrReply();
    });
    const analysis = inFlight(processInvoice(invoice.id, a.worker.id));
    await waitUntil(async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status === "ANALYZING", "el análisis");

    okOf(await as(a.worker, () => convertToTacoAction({ batchId: digital.id })));
    release();
    await analysis;
    expect(["PENDING_REVIEW", "NEEDS_ATTENTION"]).toContain((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status);
    expect(await archiveOf(invoice.id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "TACO", originalMediumReason: "taco" });
  });

  it("un PDF con texto que quedó electrónico no pasa a papel al reprocesarlo después de «Era papel» (B-R8)", async () => {
    stubOcr(async () => ocrReply());
    const digital = await makeTaco(a, { tacoNumber: null });
    const invoice = await uploadedIn(digital, 1, await testPdf({ text: true, producer: DIGITAL_PRODUCER }));
    await processInvoice(invoice.id, a.worker.id);
    expect(await archiveOf(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });

    expect(okOf(await as(a.worker, () => convertToTacoAction({ batchId: digital.id }))).converted).toBe(0);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "UPLOADED" } });
    await processInvoice(invoice.id, a.worker.id);
    expect(await archiveOf(invoice.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });
    expect(await auditsOf(invoice.id, "auto:originalMedium")).toEqual([]);
  });
});

// ── 9-13. Poner ubicación y «Sacar del taco» (B-R14, B-R16) ─────────────────

describe("«Poner ubicación» (B-R14, B-R16)", () => {
  it("en una caja: un taco ARCHIVE ya guardado; lo por confirmar pasa a papel; la familia va junta; la llegada no cambia", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    const paper = await loose("PAPER");
    const unconfirmed = await arrivedIn(digital, 1, { medium: null, source: "AUTO", reason: "scan_unconfirmed" });
    const root = await loose(null, { status: "SPLIT_SOURCE" });
    const part1 = await loose(null, { splitFromId: root.id });
    const part2 = await loose(null, { splitFromId: root.id });
    const arrivalBefore = await archiveOf(unconfirmed.id);
    const updatedBefore = await updatedAtOf(paper.id);

    const result = okOf(await as(a.worker, () => placePaperAction({
      target: { invoiceIds: [paper.id, unconfirmed.id, part1.id] },
      destination: { kind: "box", label: `${PREFIX}3` },
    })));
    expect(result).toMatchObject({ placeable: 4, unconfirmed: 3, paper: 1, skipped: { electronic: 0, inTaco: 0, rejected: 0 }, locationText: `${PREFIX}3` });
    const taco = await prisma.uploadBatch.findFirstOrThrow({ where: { origin: "ARCHIVE" } });
    expect(taco).toMatchObject({
      advisoryFirmId: a.firm.id, clientId: a.client.id, tacoNumber: result.tacoNumber, fileCount: 0, periodYear: 2026,
      periodType: null, periodMonth: null, invoiceType: null, boxLabel: `${PREFIX}3`, returnedAt: null, filedById: a.worker.id,
    });
    expect(taco.filedAt).not.toBeNull();
    for (const invoice of [paper, unconfirmed, root, part1, part2]) {
      expect(await archiveOf(invoice.id)).toMatchObject({ paperBatchId: taco.id, paperHeldByClient: false, originalMedium: "PAPER" });
    }
    expect(await archiveOf(unconfirmed.id)).toMatchObject({
      originalMediumSource: "MANUAL", originalMediumReason: "manual",
      uploadBatchId: digital.id, uploadPosition: 1, receivedAt: arrivalBefore.receivedAt,
    });
    expect(await auditsOf(unconfirmed.id, "originalMedium")).toEqual([{ oldValue: null, newValue: "PAPER", userId: a.worker.id }]);
    expect(await auditsOf(paper.id, "originalMedium")).toEqual([]);
    expect(await locationAudits(paper.id)).toEqual([{ oldValue: "Sin ubicación", newValue: `${PREFIX}3 · papel ubicado a mano`, userId: a.worker.id }]);
    expect(await locationAudits(part2.id)).toEqual([{ oldValue: "Por confirmar", newValue: `${PREFIX}3 · papel ubicado a mano`, userId: a.worker.id }]);
    expect(await updatedAtOf(paper.id)).toEqual(updatedBefore);

    // Misma caja (otras mayúsculas) del mismo cliente y ejercicio: el mismo taco.
    const more = await loose("PAPER");
    okOf(await as(a.worker, () => placePaperAction({ target: { invoiceIds: [more.id] }, destination: { kind: "box", label: "cliente a sl · 2026 · CAJA 3" } })));
    expect((await archiveOf(more.id)).paperBatchId).toBe(taco.id);
    // Otra caja, o «Caja nueva»: otro.
    const other = await loose("PAPER");
    const fresh = await loose("PAPER");
    const toOther = okOf(await as(a.worker, () => placePaperAction({ target: { invoiceIds: [other.id] }, destination: { kind: "box", label: `${PREFIX}4` } })));
    const toNew = okOf(await as(a.worker, () => placePaperAction({ target: { invoiceIds: [fresh.id] }, destination: { kind: "newBox" } })));
    expect(toNew.locationText).toBe(`${PREFIX}5`);
    const archives = await prisma.uploadBatch.findMany({ where: { origin: "ARCHIVE" }, select: { tacoNumber: true } });
    expect(archives.map((t) => t.tacoNumber).sort()).toEqual([result.tacoNumber, toOther.tacoNumber, toNew.tacoNumber].sort());
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("dos a la vez a la misma caja, con facturas distintas: un solo taco ARCHIVE con las dos", async () => {
    const first = await loose("PAPER");
    const second = await loose(null);
    // Con el bloqueo de la asesoría retenido, las dos llegan a la vez a buscar la caja.
    const lock = await holdLock(`SELECT pg_advisory_xact_lock(${TACO_LOCK_NAMESPACE}, hashtext($1))`, a.firm.id);
    signInAs(a.worker);
    const pending = [first, second].map((invoice) =>
      inFlight(placePaperAction({ target: { invoiceIds: [invoice.id] }, destination: { kind: "box", label: `${PREFIX}7` } })));
    await waitingForLock(2);
    await lock.release();
    for (const result of await Promise.all(pending)) okOf(result);
    const archives = await prisma.uploadBatch.findMany({ where: { origin: "ARCHIVE" }, select: { id: true } });
    expect(archives).toHaveLength(1);
    expect(await prisma.invoiceArchive.count({ where: { paperBatchId: archives[0].id } })).toBe(2);
  });

  it("todas juntas: la misma «Caja 12» de dos clientes o de dos ejercicios va en tacos distintos, cada uno con lo suyo", async () => {
    await prisma.advisoryFirm.update({ where: { id: a.firm.id }, data: { paperBoxMode: "SHARED" } });
    const other = await prisma.client.create({ data: { name: "Otro SL", cif: "B99887766", advisoryFirmId: a.firm.id } });
    const mine2026 = await loose("PAPER");
    const mine2025 = await loose("PAPER", { periodYear: 2025 });
    const theirs = await loose("PAPER", { client: other });
    signInAs(a.admin);
    for (const invoice of [mine2026, mine2025, theirs, await loose("PAPER")]) {
      okOf(await placePaperAction({ target: { invoiceIds: [invoice.id] }, destination: { kind: "box", label: "Caja 12" } }));
    }
    const archives = await prisma.uploadBatch.findMany({ where: { origin: "ARCHIVE" }, select: { id: true, clientId: true, periodYear: true, boxLabel: true } });
    expect(archives.map(({ clientId, periodYear, boxLabel }) => [clientId, periodYear, boxLabel]).sort()).toEqual([
      [a.client.id, 2025, "Caja 12"],
      [a.client.id, 2026, "Caja 12"],
      [other.id, 2026, "Caja 12"],
    ].sort());
    const tacoOf = new Map(archives.map((taco) => [taco.id, taco]));
    for (const [invoice, clientId, year] of [[mine2026, a.client.id, 2026], [mine2025, a.client.id, 2025], [theirs, other.id, 2026]] as const) {
      const taco = tacoOf.get((await archiveOf(invoice.id)).paperBatchId!);
      expect([taco?.clientId, taco?.periodYear]).toEqual([clientId, year]);
    }
  });

  it("«Se lo devolvemos hoy» crea un taco devuelto; «Lo tiene el cliente», sin taco", async () => {
    const returnedOne = await loose("PAPER");
    const heldOne = await loose(null);
    const returned = okOf(await as(a.admin, () => placePaperAction({ target: { invoiceIds: [returnedOne.id] }, destination: { kind: "returned" } })));
    expect(returned.locationText).toBe(`Devuelto al cliente el ${today()}`);
    const taco = await prisma.uploadBatch.findFirstOrThrow({ where: { origin: "ARCHIVE" } });
    expect(taco).toMatchObject({ boxLabel: null, filedById: a.admin.id });
    expect(taco.returnedAt).not.toBeNull();
    expect(await locationAudits(returnedOne.id)).toEqual([{ oldValue: "Sin ubicación", newValue: `Devuelto al cliente el ${today()}`, userId: a.admin.id }]);

    const held = okOf(await as(a.admin, () => placePaperAction({ target: { invoiceIds: [heldOne.id] }, destination: { kind: "client" } })));
    expect(held).toMatchObject({ tacoNumber: null, locationText: "Lo guarda el cliente" });
    expect(await archiveOf(heldOne.id)).toMatchObject({ paperHeldByClient: true, paperBatchId: null, originalMedium: "PAPER", originalMediumSource: "MANUAL" });
    expect(await prisma.uploadBatch.count({ where: { origin: "ARCHIVE" } })).toBe(1);
  });

  it("una selección mezclada: cuenta antes y ubica solo lo que vale; todo electrónico, otro cliente, 201 o nada: { error } sin cambios", async () => {
    const taco = await makeTaco(a);
    const e1 = await loose("ELECTRONIC");
    const e2 = await loose("ELECTRONIC");
    const inTaco = await arrivedIn(taco, 1);
    const u = [await loose(null), await loose(null), await loose(null)];
    const p = [await loose("PAPER"), await loose("PAPER")];
    const ids = [e1, e2, inTaco, ...u, ...p].map((invoice) => invoice.id);
    signInAs(a.worker);

    const preview = okOf(await previewPlacePaperAction({ target: { invoiceIds: ids } }));
    expect(preview).toEqual({ ok: true, placeable: 5, unconfirmed: 3, paper: 2, skipped: { electronic: 2, inTaco: 1, rejected: 0, analyzing: 0 } });
    const placed = okOf(await placePaperAction({ target: { invoiceIds: ids }, destination: { kind: "box", label: `${PREFIX}1` } }));
    expect(placed).toMatchObject({ placeable: 5, unconfirmed: 3, paper: 2, skipped: { electronic: 2, inTaco: 1, rejected: 0, analyzing: 0 } });
    for (const invoice of [e1, e2, inTaco]) expect((await archiveOf(invoice.id)).paperBatchId).toBeNull();
    for (const invoice of [...u, ...p]) expect((await archiveOf(invoice.id)).paperBatchId).not.toBeNull();

    expect(await placePaperAction({ target: { invoiceIds: [e1.id, e2.id] }, destination: { kind: "box", label: `${PREFIX}9` } }))
      .toEqual({ error: "Ninguna de las elegidas se puede ubicar: 2 electrónicas." });
    expect(await prisma.uploadBatch.count({ where: { origin: "ARCHIVE" } })).toBe(1);

    const otherClient = await prisma.client.create({ data: { name: "Otro SL", cif: "B99887766", advisoryFirmId: a.firm.id } });
    const foreign = await loose("PAPER", { client: otherClient });
    signInAs(a.admin);
    expect(await previewPlacePaperAction({ target: { invoiceIds: [p[0].id, foreign.id] } })).toEqual({ error: MIXED_CLIENTS });
    expect(await placePaperAction({ target: { invoiceIds: Array.from({ length: 201 }, (_, i) => `x${i}`) }, destination: { kind: "returned" } }))
      .toEqual({ error: "Como mucho 200 facturas a la vez." });
    expect(await placePaperAction({ target: { invoiceIds: ["no-existe"] }, destination: { kind: "returned" } }))
      .toEqual({ error: "No tienes acceso a estas facturas." });
    const emptyClient = await prisma.client.create({ data: { name: "Vacío SL", cif: "B12121212", advisoryFirmId: a.firm.id } });
    expect(await placePaperAction({ target: { clientId: emptyClient.id, fiscalYear: 2026, includeUnconfirmed: true }, destination: { kind: "returned" } }))
      .toEqual({ error: NOTHING_WITHOUT_LOCATION });
  });

  it("a todas las de un cliente y ejercicio: sin la casilla el papel; con ella, también lo por confirmar", async () => {
    // makeFirm ya deja dos «Por confirmar» de septiembre de 2026.
    const paper = [await loose("PAPER"), await loose("PAPER"), await loose("PAPER")];
    await loose("PAPER", { status: "REJECTED" });
    await loose("PAPER", { periodYear: 2025 });
    signInAs(a.worker);
    const paperOnly = { clientId: a.client.id, fiscalYear: 2026, includeUnconfirmed: false };
    expect(okOf(await previewPlacePaperAction({ target: paperOnly }))).toMatchObject({ placeable: 3, paper: 3, unconfirmed: 0 });
    const everything = { ...paperOnly, includeUnconfirmed: true };
    expect(okOf(await previewPlacePaperAction({ target: everything }))).toMatchObject({ placeable: 5, paper: 3, unconfirmed: 2 });
    const placed = okOf(await placePaperAction({ target: everything, destination: { kind: "box", label: `${PREFIX}2` } }));
    expect(placed.placeable).toBe(5);
    for (const invoice of [...paper, a.invoices.pending, a.invoices.validated]) {
      expect((await archiveOf(invoice.id)).paperBatchId).not.toBeNull();
    }
    expect(await previewPlacePaperAction({ target: everything })).toEqual({ error: NOTHING_WITHOUT_LOCATION });
    // Un gestor sin el cliente no ve el ámbito.
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    expect(await as(stranger, () => previewPlacePaperAction({ target: everything }))).toEqual({ error: "No tienes acceso a estas facturas." });
  });

  it("lo «Por confirmar» que espera su análisis o se analiza no se ubica (ni «a todas» ni elegido): el análisis aún puede decir que es electrónico", async () => {
    const digital = await makeTaco(a, { tacoNumber: null });
    const waiting = await uploadedIn(digital, 1, await testPdf({ text: true, producer: DIGITAL_PRODUCER }));
    const analyzing = await loose(null, { status: "ANALYZING" });
    // Una división con una parte aún por analizar: la familia entera espera (como setOriginalMedium).
    const root = await loose(null, { status: "SPLIT_SOURCE" });
    const part1 = await loose(null, { status: "UPLOADED", splitFromId: root.id });
    const part2 = await loose(null, { status: "PENDING_REVIEW", splitFromId: root.id });
    const paper = await loose("PAPER");
    signInAs(a.worker);

    // «A todas» con la casilla: el papel y las dos «Por confirmar» de makeFirm; part2 sale como «se está analizando».
    const everything = { clientId: a.client.id, fiscalYear: 2026, includeUnconfirmed: true };
    expect(okOf(await previewPlacePaperAction({ target: everything })))
      .toEqual({ ok: true, placeable: 3, unconfirmed: 2, paper: 1, skipped: { electronic: 0, inTaco: 0, rejected: 0, analyzing: 2 } });
    const placed = okOf(await placePaperAction({ target: everything, destination: { kind: "box", label: `${PREFIX}1` } }));
    expect(placed).toMatchObject({ placeable: 3, skipped: { analyzing: 2 } });
    expect((await archiveOf(paper.id)).paperBatchId).not.toBeNull();
    for (const invoice of [waiting, analyzing, root, part1, part2]) {
      expect(await archiveOf(invoice.id)).toMatchObject({ paperBatchId: null, paperHeldByClient: false, originalMedium: null });
    }

    // Elegidas una a una tampoco.
    expect(await placePaperAction({ target: { invoiceIds: [waiting.id, analyzing.id] }, destination: { kind: "client" } }))
      .toEqual({ error: "Ninguna de las elegidas se puede ubicar: 2 se están analizando." });
    expect(okOf(await previewPlacePaperAction({ target: { invoiceIds: [part2.id] } }))).toMatchObject({ placeable: 0, skipped: { analyzing: 2 } });

    // Y el análisis, al terminar, sí puede decir que es electrónica.
    stubOcr(async () => ocrReply());
    await processInvoice(waiting.id, a.worker.id);
    expect(await archiveOf(waiting.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", paperBatchId: null });
  });

  it("dos a la vez sobre las mismas facturas: una las ubica y la otra las salta, sin taco vacío ni auditoría doble", async () => {
    const invoices = [await loose("PAPER"), await loose(null)];
    const ids = invoices.map((invoice) => invoice.id);
    const lock = await holdLock(`SELECT 1 FROM "InvoiceArchive" WHERE "invoiceId" = $1 FOR UPDATE`, ids[0]);
    signInAs(a.worker);
    const first = inFlight(placePaperAction({ target: { invoiceIds: ids }, destination: { kind: "box", label: `${PREFIX}1` } }));
    await waitingForLock(1);
    const second = inFlight(placePaperAction({ target: { invoiceIds: ids }, destination: { kind: "returned" } }));
    await waitingForLock(2);
    await lock.release();
    const results = await Promise.all([first, second]);
    const failed = results.filter((result) => "error" in result);
    expect(results.filter((result) => "ok" in result)).toHaveLength(1);
    expect(failed).toEqual([{ error: "Ninguna de las elegidas se puede ubicar: 2 ya en un taco." }]);
    const archives = await prisma.uploadBatch.findMany({ where: { origin: "ARCHIVE" }, select: { id: true } });
    expect(archives).toHaveLength(1);
    expect(await prisma.invoiceArchive.count({ where: { paperBatchId: archives[0].id } })).toBe(2);
    for (const id of ids) expect(await locationAudits(id)).toHaveLength(1);
  });

  it("«Sacar del taco»: devuelta, a otra caja o al cliente; la hoja del taco lo dice; solo de una en una", async () => {
    const taco = await makeTaco(a, { fileCount: 4, filed: { boxLabel: `${PREFIX}1` } });
    const x = await arrivedIn(taco, 2);
    const y = await arrivedIn(taco, 3);
    const z = await arrivedIn(taco, 4);
    signInAs(a.worker);

    okOf(await previewPlacePaperAction({ target: { moveInvoiceId: x.id } }));
    okOf(await placePaperAction({ target: { moveInvoiceId: x.id }, destination: { kind: "returned" } }));
    expect(await locationAudits(x.id)).toEqual([
      { oldValue: `${PREFIX}1 · Taco ${taco.tacoNumber} · Pág. 2`, newValue: `Devuelto al cliente el ${today()}`, userId: a.worker.id },
    ]);
    okOf(await placePaperAction({ target: { moveInvoiceId: y.id }, destination: { kind: "box", label: `${PREFIX}2` } }));
    expect((await locationAudits(y.id))[0].newValue).toBe(`${PREFIX}2 · papel ubicado a mano`);
    okOf(await placePaperAction({ target: { moveInvoiceId: z.id }, destination: { kind: "client" } }));
    expect(await archiveOf(z.id)).toMatchObject({ paperHeldByClient: true, paperBatchId: null });
    expect((await locationAudits(z.id))[0].newValue).toBe("Lo guarda el cliente");

    // La hoja del taco de llegada: la página 2, sacada y devuelta.
    const rows = await prisma.invoiceArchive.findMany({
      where: { uploadBatchId: taco.id },
      select: {
        invoiceId: true, uploadPosition: true, splitPart: true, originalMedium: true, paperHeldByClient: true, paperBatchId: true,
        invoice: { select: { clientId: true, status: true, splitFromId: true } },
        paperBatch: { select: { tacoNumber: true, returnedAt: true, origin: true } },
      },
    });
    const slots = tacoSlots({
      batchId: taco.id, fileCount: 4, wholePdf: false, pdfPageCount: null, split: false,
      rows: rows.map((row) => ({
        invoiceId: row.invoiceId, clientId: row.invoice.clientId, status: row.invoice.status, splitFromId: row.invoice.splitFromId,
        uploadPosition: row.uploadPosition, splitPart: row.splitPart, medium: row.originalMedium, paperHeldByClient: row.paperHeldByClient,
        paperBatchId: row.paperBatchId, paperTacoNumber: row.paperBatch?.tacoNumber ?? null,
        paperTacoReturnedAt: row.paperBatch?.returnedAt ?? null, paperTacoOrigin: row.paperBatch?.origin ?? null,
      })),
    });
    expect(slots[1].label).toBe(`Sacada: devuelta al cliente el ${today()}`);
    expect(slots[3].label).toBe("Lo guarda el cliente");

    // «Sacar» es de una en una, y solo con el papel en un taco.
    expect(await placePaperAction({ target: { moveInvoiceId: [x.id, y.id] }, destination: { kind: "returned" } })).toHaveProperty("error");
    expect(await placePaperAction({ target: { invoiceIds: [x.id], moveInvoiceId: x.id }, destination: { kind: "returned" } })).toHaveProperty("error");
    const free = await loose("PAPER");
    expect(await placePaperAction({ target: { moveInvoiceId: free.id }, destination: { kind: "returned" } })).toEqual({ error: NOT_IN_A_TACO });
  });
});

// ── 14. Anular un taco (B-R22) ──────────────────────────────────────────────

describe("anular un taco (B-R22)", () => {
  const voidAs = (user: TestSessionUser, batchId: string, reason = "Subido al cliente equivocado") =>
    as(user, () => voidTacoAction({ batchId, reason }));

  it("un taco entero sin dividir: anulado con su motivo, una sola vez; anulado no se guarda", async () => {
    const whole = await makeTaco(a, { wholePdf: { pageCount: 12 } });
    expect(await voidAs(a.worker, whole.id)).toEqual({ ok: true, tacoNumber: whole.tacoNumber });
    expect(await batchOf(whole.id)).toMatchObject({ voidedById: a.worker.id, voidReason: "Subido al cliente equivocado", tacoNumber: whole.tacoNumber });
    expect((await batchOf(whole.id)).voidedAt).not.toBeNull();
    expect(await voidAs(a.worker, whole.id)).toEqual({ error: VOID_ALREADY });
    expect(await as(a.worker, () => fileTacoAction({ batchId: whole.id, destination: { kind: "returned" } }))).toEqual({ error: TACO_VOIDED });
  });

  it("con una factura viva no; con todas rechazadas sí, y su ubicación dice «taco anulado»; con papel de fuera, un ARCHIVE o sin motivo, no", async () => {
    const alive = await makeTaco(a);
    await arrivedIn(alive, 1, { status: "REJECTED" });
    await arrivedIn(alive, 2);
    expect(await voidAs(a.admin, alive.id)).toEqual({ error: VOID_ALIVE_INVOICES });

    const rejected = await makeTaco(a);
    const r1 = await arrivedIn(rejected, 1, { status: "REJECTED" });
    okOf(await voidAs(a.admin, rejected.id, "  Era de otro cliente  "));
    expect((await batchOf(rejected.id)).voidReason).toBe("Era de otro cliente");
    expect(await locationAudits(r1.id)).toEqual([
      { oldValue: `Taco ${rejected.tacoNumber} · Pág. 1 (sin guardar)`, newValue: `Taco ${rejected.tacoNumber} · Pág. 1 (taco anulado)`, userId: a.admin.id },
    ]);

    const host = await makeTaco(a);
    const outsider = await loose("PAPER");
    await prisma.invoiceArchive.update({ where: { invoiceId: outsider.id }, data: { paperBatchId: host.id } });
    expect(await voidAs(a.admin, host.id)).toEqual({ error: VOID_PAPER_FROM_OUTSIDE });

    const archived = await makeTaco(a, { origin: "ARCHIVE", filed: { boxLabel: "Caja 1" } });
    expect(await voidAs(a.admin, archived.id)).toEqual({ error: VOID_ARCHIVE });
    const empty = await makeTaco(a);
    expect(await voidAs(a.admin, empty.id, "x")).toEqual({ error: VOID_REASON_ERROR });
    expect(await voidAs(a.admin, empty.id, "x".repeat(201))).toEqual({ error: VOID_REASON_ERROR });
    expect(await voidAs(a.admin, empty.id, "x".repeat(401))).toEqual({ error: VOID_REASON_ERROR });

    const b = await makeFirm("B");
    const stranger = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    for (const user of [b.admin, stranger]) expect(await voidAs(user, empty.id)).toEqual({ error: "No tienes acceso a este taco." });
    expect((await batchOf(empty.id)).voidedAt).toBeNull();
  });

  it("una subida que llega mientras se anula: la anulación sale bien y la subida da 409 ERR-UPLOAD-008 sin factura ni objeto", async () => {
    const taco = await makeTaco(a);
    const invoicesBefore = await prisma.invoice.count();
    const keysBefore = fakeS3().keys().length;
    // La anulación bloquea la tanda y se para en las filas de archivo.
    const lock = await holdLock(`LOCK TABLE "InvoiceArchive" IN EXCLUSIVE MODE`);
    signInAs(a.admin);
    const voiding = inFlight(voidTacoAction({ batchId: taco.id, reason: "Subido por error" }));
    await waitingForLock(1);
    // La subida pasa las comprobaciones, sube el fichero y espera la tanda (FOR SHARE).
    const uploading = inFlight(post(a.admin, await pdf(), { id: taco.id, position: 1 }));
    await waitingForLock(2);
    await lock.release();

    expect(await voiding).toEqual({ ok: true, tacoNumber: taco.tacoNumber });
    const response = await uploading;
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ERR-UPLOAD-008");
    expect(await prisma.invoice.count()).toBe(invoicesBefore);
    expect(fakeS3().keys()).toHaveLength(keysBefore);
  });
});

// ── 15. Completar un taco (B-R23) ───────────────────────────────────────────

describe("completar un taco (B-R23)", () => {
  const extendAs = (batchId: string, expectedFileCount: number, addCount: number) =>
    as(a.worker, () => extendTacoAction({ batchId, expectedFileCount, addCount }));

  it("hace sitio al final y después se suben esas páginas; con el nº viejo, otro tipo de tanda o más de 500, no", async () => {
    const taco = await makeTaco(a, { fileCount: 5 });
    expect(await extendAs(taco.id, 5, 2)).toEqual({ ok: true, fileCount: 7, firstNewPosition: 6 });
    expect((await batchOf(taco.id)).fileCount).toBe(7);
    expect(await extendAs(taco.id, 5, 1)).toEqual({ error: EXTEND_CONFLICT });
    expect(await extendAs(taco.id, 499, 2)).toEqual({ error: EXTEND_TOO_MANY });

    const whole = await makeTaco(a, { wholePdf: { pageCount: 3 } });
    const voided = await makeTaco(a, { voided: { reason: "Subido por error" } });
    const digital = await makeTaco(a, { tacoNumber: null });
    expect(await extendAs(whole.id, 1, 1)).toEqual({ error: EXTEND_WHOLE_PDF });
    expect(await extendAs(voided.id, 3, 1)).toEqual({ error: TACO_VOIDED });
    expect(await extendAs(digital.id, 3, 1)).toEqual({ error: EXTEND_NOT_A_TACO });
    expect((await batchOf(digital.id)).fileCount).toBe(3);

    for (const position of [6, 7]) {
      const response = await post(a.worker, await pdf(), { id: taco.id, position });
      expect(response.status).toBe(200);
      expect(await archiveOf(response.body.invoiceId)).toMatchObject({ uploadBatchId: taco.id, uploadPosition: position, originalMedium: "PAPER" });
    }
    expect((await post(a.worker, await pdf(), { id: taco.id, position: 8 })).body.error.code).toBe("ERR-UPLOAD-008");
  });

  it("con el periodo del lote cerrado no hace sitio (la subida no entraría y las páginas quedarían sin factura para siempre)", async () => {
    const taco = await makeTaco(a, { fileCount: 3 });
    const closure = await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 9, year: 2026, closedBy: a.admin.id } });
    expect(await extendAs(taco.id, 3, 2)).toEqual({ error: "El periodo está cerrado. Pide a un administrador de tu asesoría que lo reabra." });
    expect((await batchOf(taco.id)).fileCount).toBe(3);

    // Reabierto, sí.
    await prisma.periodClosure.update({ where: { id: closure.id }, data: { reopenedAt: new Date() } });
    expect(await extendAs(taco.id, 3, 2)).toEqual({ ok: true, fileCount: 5, firstNewPosition: 4 });
  });
});

// ── 16. Ninguna toca Invoice.updatedAt ──────────────────────────────────────

describe("ninguna escritura de los tacos toca la factura (R1)", () => {
  it("con una revisión abierta, validar con el updatedAt leído antes sigue funcionando", async () => {
    const taco = await makeTaco(a, { fileCount: 2 });
    const inTaco = await arrivedIn(taco, 1);
    const digital = await makeTaco(a, { tacoNumber: null });
    const converted = await arrivedIn(digital, 1, { medium: null, source: "AUTO", reason: "scan_unconfirmed" });
    const placed = await loose(null, { status: "PENDING_REVIEW" });
    const reads = await Promise.all([inTaco, converted, placed].map(async (invoice) => [invoice.id, await updatedAtOf(invoice.id)] as const));

    signInAs(a.worker);
    okOf(await fileTacoAction({ batchId: taco.id, destination: { kind: "box", label: `${PREFIX}1` } }));
    okOf(await extendTacoAction({ batchId: taco.id, expectedFileCount: 2, addCount: 1 }));
    okOf(await placePaperAction({ target: { moveInvoiceId: inTaco.id }, destination: { kind: "returned" } }));
    okOf(await convertToTacoAction({ batchId: digital.id }));
    okOf(await placePaperAction({ target: { invoiceIds: [placed.id] }, destination: { kind: "newBox" } }));

    for (const [i, [id, updatedAt]] of reads.entries()) {
      expect(await updatedAtOf(id)).toEqual(updatedAt);
      expect((await validate(reviewForm(id, updatedAt, a.client, { invoiceNumber: `F-R1-${i}` }))).error).toBeNull();
    }
  });
});
