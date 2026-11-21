// Archivo, paso 8: electrónico o papel y «conservar más», a mano, por las
// acciones de /dashboard/archivo. Solo escriben en InvoiceArchive: una
// revisión abierta no se entera (R1), y valen con el periodo cerrado o con la
// factura exportada.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Invoice, Prisma } from "@prisma/client";
import { prisma } from "./helpers/db";
import { makeFirm, makeInvoice, makeUser, type FirmWorld } from "./helpers/factories";
import { signInAs } from "./helpers/session";
import { reviewForm, validate } from "./helpers/reviewForm";
import { holdLock } from "./helpers/locks";
import {
  attachOriginalDocumentAction,
  removeOriginalDocumentAction,
  setOriginalMediumAction,
  setRetentionHoldAction,
} from "@/app/dashboard/archivo/actions";
import { ARCHIVE_EDIT_CONFLICT_ERROR, ARCHIVE_EDIT_WAITS } from "@/lib/archiveEdits";
import { verifyFirmAuditChains } from "@/lib/auditLog";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
});

const archiveRow = (invoiceId: string) => prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId } });
const updatedAtOf = async (id: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id } })).updatedAt;
const audits = (field: string, invoiceIds?: string[]) =>
  prisma.auditLog.findMany({
    where: { field, ...(invoiceIds ? { invoiceId: { in: invoiceIds } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { invoiceId: true, userId: true, oldValue: true, newValue: true },
  });
const setArchive = (invoiceId: string, data: Prisma.InvoiceArchiveUpdateInput) =>
  prisma.invoiceArchive.update({ where: { invoiceId }, data });

/** Las filas de archivo, para ver que no han cambiado (ni su updatedAt). */
const snapshot = (ids: string[]) =>
  prisma.invoiceArchive.findMany({ where: { invoiceId: { in: ids } }, orderBy: { invoiceId: "asc" } });

/** Una original dividida en dos partes, con la segunda dividida otra vez. */
async function splitFamily(w: FirmWorld) {
  const root = await makeInvoice(w.client, { status: "SPLIT_SOURCE", invoiceNumber: null });
  const p1 = await makeInvoice(w.client, { splitFromId: root.id, status: "PENDING_REVIEW" });
  const p2 = await makeInvoice(w.client, { splitFromId: root.id, status: "SPLIT_SOURCE", invoiceNumber: null });
  const g1 = await makeInvoice(w.client, { splitFromId: p2.id, status: "VALIDATED" });
  const g2 = await makeInvoice(w.client, { splitFromId: p2.id, status: "NEEDS_ATTENTION" });
  const family = [root, p1, p2, g1, g2];
  for (const inv of family) {
    await setArchive(inv.id, { originalMedium: null, originalMediumSource: "AUTO", originalMediumReason: inv === root ? "scan_unconfirmed" : "split" });
  }
  return { root, p1, p2, g1, g2, ids: family.map((inv) => inv.id) };
}

describe("solo escriben en el archivo (R1)", () => {
  it("tras cambiar el medio y «conservar más», Invoice.updatedAt no cambia y validar con el updatedAt leído antes funciona", async () => {
    const inv = a.invoices.pending;
    const before = await updatedAtOf(inv.id);
    signInAs(a.worker);
    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "PAPER" })).toEqual({ ok: true, changed: 1 });
    expect(await setRetentionHoldAction({ invoiceIds: [inv.id], hold: true, reason: "FIXED_ASSET", note: " Furgoneta " }))
      .toEqual({ ok: true, changed: 1 });

    expect(await updatedAtOf(inv.id)).toEqual(before);
    expect(await archiveRow(inv.id)).toMatchObject({
      originalMedium: "PAPER",
      originalMediumSource: "MANUAL",
      originalMediumReason: "manual",
      retentionHold: true,
      retentionHoldReason: "FIXED_ASSET",
      retentionHoldNote: "Furgoneta",
    });
    // La revisión que se abrió antes valida sin ERR-VALIDATE-003.
    expect((await validate(reviewForm(inv.id, before, a.client))).error).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("VALIDATED");
  });

  it("con el periodo cerrado y con la factura ya exportada, también; al reabrir, la corrección con el updatedAt de antes entra", async () => {
    const inv = a.invoices.validated;
    const batch = await prisma.exportBatch.create({
      data: { format: "a3excel", clientId: a.client.id, periodMonth: 9, periodYear: 2026, invoiceCount: 1, userId: a.admin.id },
    });
    await prisma.exportBatchItem.create({ data: { exportBatchId: batch.id, invoiceId: inv.id, snapshot: "{}" } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { exportBatchId: batch.id } });
    const closure = await prisma.periodClosure.create({ data: { clientId: a.client.id, month: 9, year: 2026, closedBy: a.admin.id } });
    const before = await updatedAtOf(inv.id);

    signInAs(a.admin);
    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "ELECTRONIC" })).toEqual({ ok: true, changed: 1 });
    expect(await setRetentionHoldAction({ invoiceIds: [inv.id], hold: true, reason: "INSPECTION", note: null })).toEqual({ ok: true, changed: 1 });
    expect(await updatedAtOf(inv.id)).toEqual(before);
    expect(await archiveRow(inv.id)).toMatchObject({ originalMedium: "ELECTRONIC", retentionHold: true, retentionHoldReason: "INSPECTION" });

    await prisma.periodClosure.update({ where: { id: closure.id }, data: { reopenedAt: new Date(), reopenedBy: a.admin.id } });
    expect((await validate(reviewForm(inv.id, before, a.client, { invoiceNumber: "F-corregida" }))).error).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).invoiceNumber).toBe("F-corregida");
  });
});

describe("electrónico o papel a mano (R11, anexo C2)", () => {
  it("cambiar el medio de una parte cambia el de toda la familia (la original, las hermanas y las nietas) y audita cada una", async () => {
    const fam = await splitFamily(a);
    const other = a.invoices.validated;
    const otherBefore = await snapshot([other.id]);
    signInAs(a.admin);
    expect(await setOriginalMediumAction({ invoiceIds: [fam.g1.id], medium: "PAPER" })).toEqual({ ok: true, changed: 5 });

    for (const id of fam.ids) {
      expect(await archiveRow(id)).toMatchObject({ originalMedium: "PAPER", originalMediumSource: "MANUAL", originalMediumReason: "manual" });
    }
    const entries = await audits("originalMedium");
    expect(entries.map((e) => e.invoiceId).sort()).toEqual([...fam.ids].sort());
    expect(entries.every((e) => e.oldValue === null && e.newValue === "PAPER" && e.userId === a.admin.id)).toBe(true);
    expect(await snapshot([other.id])).toEqual(otherBefore);
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("«Por confirmar» a mano es el medio vacío con origen MANUAL; confirmar lo que propuso la app audita, y repetir lo mismo no", async () => {
    const inv = a.invoices.pending;
    await setArchive(inv.id, { originalMedium: "ELECTRONIC", originalMediumSource: "AUTO", originalMediumReason: "pdf_text" });
    signInAs(a.worker);

    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "ELECTRONIC" })).toEqual({ ok: true, changed: 1 });
    expect(await archiveRow(inv.id)).toMatchObject({ originalMedium: "ELECTRONIC", originalMediumSource: "MANUAL", originalMediumReason: "manual" });
    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "ELECTRONIC" })).toEqual({ ok: true, changed: 0 });

    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "UNCONFIRMED" })).toEqual({ ok: true, changed: 1 });
    expect(await archiveRow(inv.id)).toMatchObject({ originalMedium: null, originalMediumSource: "MANUAL", originalMediumReason: "manual" });
    expect((await audits("originalMedium")).map((e) => [e.oldValue, e.newValue])).toEqual([
      ["ELECTRONIC", "ELECTRONIC"],
      ["ELECTRONIC", null],
    ]);
  });

  it("en bloque: varias facturas del mismo cliente a la vez", async () => {
    const extra = await makeInvoice(a.client, { status: "VALIDATED" });
    const ids = [a.invoices.pending.id, a.invoices.validated.id, extra.id];
    signInAs(a.worker);
    expect(await setOriginalMediumAction({ invoiceIds: ids, medium: "PAPER" })).toEqual({ ok: true, changed: 3 });
    for (const id of ids) expect((await archiveRow(id)).originalMedium).toBe("PAPER");
    expect((await audits("originalMedium")).length).toBe(3);
  });

  it("con alguna factura de la familia analizándose (UPLOADED o ANALYZING) da error y no cambia nada", async () => {
    const fam = await splitFamily(a);
    await prisma.invoice.update({ where: { id: fam.g2.id }, data: { status: "ANALYZING" } });
    const uploaded = await makeInvoice(a.client, { status: "UPLOADED" });
    const before = await snapshot([...fam.ids, uploaded.id]);
    signInAs(a.admin);
    for (const ids of [[fam.p1.id], [uploaded.id]]) {
      const res = await setOriginalMediumAction({ invoiceIds: ids, medium: "PAPER" });
      expect("error" in res && res.error).toMatch(/se está analizando/);
    }
    expect(await snapshot([...fam.ids, uploaded.id])).toEqual(before);
    expect(await audits("originalMedium")).toEqual([]);
  });

  it("un medio que no existe o ninguna factura: { error }", async () => {
    signInAs(a.admin);
    expect(await setOriginalMediumAction({ invoiceIds: [a.invoices.pending.id], medium: "OTRO" }))
      .toEqual({ error: "Elige electrónico, papel o por confirmar." });
    expect(await setOriginalMediumAction({ invoiceIds: [], medium: "PAPER" })).toEqual({ error: "Elige alguna factura." });
    expect(await setOriginalMediumAction("nada")).toHaveProperty("error");
  });
});

describe("«conservar más» (R12)", () => {
  it("en bloque, con motivo y nota; cambiar solo la nota no audita; quitarlo audita «No» y borra motivo y nota", async () => {
    const ids = [a.invoices.pending.id, a.invoices.validated.id];
    signInAs(a.worker);
    expect(await setRetentionHoldAction({ invoiceIds: ids, hold: true, reason: "INSPECTION", note: " Acta 2026 " }))
      .toEqual({ ok: true, changed: 2 });
    for (const id of ids) {
      expect(await archiveRow(id)).toMatchObject({ retentionHold: true, retentionHoldReason: "INSPECTION", retentionHoldNote: "Acta 2026" });
    }
    expect((await audits("retentionHold")).map((e) => [e.invoiceId, e.oldValue, e.newValue])).toEqual(
      expect.arrayContaining(ids.map((id) => [id, "false", "INSPECTION"])),
    );

    expect(await setRetentionHoldAction({ invoiceIds: ids, hold: true, reason: "INSPECTION", note: "Acta 2027" }))
      .toEqual({ ok: true, changed: 2 });
    expect((await archiveRow(ids[0])).retentionHoldNote).toBe("Acta 2027");
    expect((await audits("retentionHold")).length).toBe(2);

    expect(await setRetentionHoldAction({ invoiceIds: [ids[0]], hold: false, reason: "INSPECTION", note: "se ignora" }))
      .toEqual({ ok: true, changed: 1 });
    expect(await archiveRow(ids[0])).toMatchObject({ retentionHold: false, retentionHoldReason: null, retentionHoldNote: null });
    expect((await audits("retentionHold", [ids[0]])).map((e) => [e.oldValue, e.newValue])).toEqual([
      ["false", "INSPECTION"],
      ["INSPECTION", "false"],
    ]);
    expect((await verifyFirmAuditChains(a.firm.id)).brokenChains).toBe(0);
  });

  it("sin motivo, con una nota de más de 500, con facturas de dos clientes o de otra asesoría: { error } sin cambios", async () => {
    const other = await prisma.client.create({ data: { name: "Otro cliente SL", cif: "B99887766", advisoryFirmId: a.firm.id } });
    const otherInvoice = await makeInvoice(other, { status: "VALIDATED" });
    const ids = [a.invoices.pending.id, otherInvoice.id];
    const before = await snapshot(ids);
    signInAs(a.admin);
    expect(await setRetentionHoldAction({ invoiceIds: [ids[0]], hold: true, reason: null, note: null }))
      .toEqual({ error: "Elige por qué hay que conservarlas más." });
    expect(await setRetentionHoldAction({ invoiceIds: [ids[0]], hold: true, reason: "OTHER", note: "x".repeat(501) }))
      .toEqual({ error: "La nota no puede pasar de 500 caracteres." });
    expect(await setRetentionHoldAction({ invoiceIds: ids, hold: true, reason: "OTHER", note: null }))
      .toEqual({ error: "Las facturas tienen que ser del mismo cliente." });
    expect(await setOriginalMediumAction({ invoiceIds: ids, medium: "PAPER" }))
      .toEqual({ error: "Las facturas tienen que ser del mismo cliente." });
    expect(await snapshot(ids)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { field: { in: ["retentionHold", "originalMedium"] } } })).toBe(0);
  });
});

describe("acceso (R22)", () => {
  it("un gestor sin el cliente, otra asesoría o el portal: { error } sin cambios ni auditoría", async () => {
    const unassigned = await makeUser(a.firm.id, "WORKER", "gestorsincliente");
    const target: Invoice = a.invoices.pending;
    const ids = [target.id, a.invoices.validated.id];
    const before = await snapshot(ids);
    const tries: [Parameters<typeof signInAs>[0], string][] = [
      [unassigned, "No tienes acceso a estas facturas."],
      [b.admin, "No tienes acceso a estas facturas."],
      [b.worker, "No tienes acceso a estas facturas."],
      [a.clientUser, "No autorizado"],
    ];
    for (const [user, message] of tries) {
      signInAs(user);
      expect(await setOriginalMediumAction({ invoiceIds: [target.id], medium: "PAPER" })).toEqual({ error: message });
      expect(await setRetentionHoldAction({ invoiceIds: ids, hold: true, reason: "OTHER", note: null })).toEqual({ error: message });
    }
    // Una sola factura sin acceso en la selección basta para no tocar ninguna.
    const foreign = await makeInvoice(b.client, { status: "VALIDATED" });
    signInAs(a.admin);
    expect(await setRetentionHoldAction({ invoiceIds: [target.id, foreign.id], hold: true, reason: "OTHER", note: null }))
      .toEqual({ error: "No tienes acceso a estas facturas." });

    expect(await snapshot(ids)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { field: { in: ["retentionHold", "originalMedium"] } } })).toBe(0);
  });
});

describe("conflictos (anexo C11)", () => {
  const defaultLockTimeout = ARCHIVE_EDIT_WAITS.lockTimeoutMs;
  afterEach(() => {
    ARCHIVE_EDIT_WAITS.lockTimeoutMs = defaultLockTimeout;
  });

  it("si otra transacción retiene las filas más del lock_timeout: «Otra persona…», sin cambios ni auditoría", async () => {
    ARCHIVE_EDIT_WAITS.lockTimeoutMs = 300;
    const fam = await splitFamily(a);
    const inv = a.invoices.pending;
    const before = await snapshot([inv.id, ...fam.ids]);
    signInAs(a.admin);

    const rowLock = await holdLock(`SELECT 1 FROM "InvoiceArchive" WHERE "invoiceId" = $1 FOR UPDATE`, inv.id);
    expect(await setRetentionHoldAction({ invoiceIds: [inv.id], hold: true, reason: "OTHER", note: null }))
      .toEqual({ error: ARCHIVE_EDIT_CONFLICT_ERROR });
    expect(await setOriginalMediumAction({ invoiceIds: [inv.id], medium: "PAPER" })).toEqual({ error: ARCHIVE_EDIT_CONFLICT_ERROR });
    await rowLock.release();

    // La raíz de una división retenida (una división o la detección a la vez).
    const rootLock = await holdLock(`SELECT 1 FROM "InvoiceArchive" WHERE "invoiceId" = $1 FOR UPDATE`, fam.root.id);
    expect(await setOriginalMediumAction({ invoiceIds: [fam.p1.id], medium: "PAPER" })).toEqual({ error: ARCHIVE_EDIT_CONFLICT_ERROR });
    await rootLock.release();

    expect(await snapshot([inv.id, ...fam.ids])).toEqual(before);
    expect(await prisma.auditLog.count({ where: { field: { in: ["retentionHold", "originalMedium"] } } })).toBe(0);
    // Ya sin el bloqueo, sale bien.
    expect(await setOriginalMediumAction({ invoiceIds: [fam.p1.id], medium: "PAPER" })).toEqual({ ok: true, changed: 5 });
  });
});

describe("las acciones nunca lanzan (AGENTS.md)", () => {
  it("si la BD falla al comprobar el acceso, las cuatro devuelven { error } en vez de lanzar a la UI", async () => {
    // Un id con un byte nulo pasa zod y Postgres lo rechaza (22021) en la
    // consulta de acceso: es como cualquier otro fallo de la BD ahí.
    const broken = `x${String.fromCharCode(0)}y`;
    const form = new FormData();
    form.set("invoiceId", broken);
    form.set("file", new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "original.doc"));
    signInAs(a.worker);
    const failed = { error: "No se ha podido guardar. Inténtalo de nuevo." };
    await expect(setOriginalMediumAction({ invoiceIds: [broken], medium: "PAPER" })).resolves.toEqual(failed);
    await expect(setRetentionHoldAction({ invoiceIds: [broken], hold: false })).resolves.toEqual(failed);
    await expect(attachOriginalDocumentAction(form)).resolves.toEqual(failed);
    await expect(removeOriginalDocumentAction({ invoiceId: broken })).resolves.toEqual(failed);
    expect(await prisma.auditLog.count({ where: { field: { in: ["retentionHold", "originalMedium", "originalDocument"] } } })).toBe(0);
  });
});
