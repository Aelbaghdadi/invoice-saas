// Aislamiento entre asesorías en la pantalla de revisión y en el archivo: el
// ADMIN de otra asesoría, conociendo el id, no puede tocar ni ver una factura de A.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, PNG_DATA_URL } from "./helpers/fixtures";
import { signInAs } from "./helpers/session";
import { reject, reviewForm, settleAction, validate } from "./helpers/reviewForm";
import {
  saveInvoiceFields, splitInvoice, splitPdfInvoice,
} from "@/app/dashboard/worker/review/[id]/actions";
import { GET as archiveOriginal } from "@/app/api/archive/invoices/[id]/original/route";
import { GET as archiveZip } from "@/app/api/archive/clients/[id]/zip/route";
import { attachOriginalDocumentAction, removeOriginalDocumentAction } from "@/app/dashboard/archivo/actions";
import { POST as upload } from "@/app/api/uploads/route";
import { archiveScope, canAccessArchiveInvoice, canAccessUploadBatch } from "@/lib/archiveAccess";
import { loadArchiveInvoice, loadArchiveMetrics, loadClientArchive, searchArchive } from "@/lib/archiveData";

const NO_ACCESS = "No tienes acceso a esta factura.";

let a: FirmWorld;
let b: FirmWorld;

beforeEach(async () => {
  a = await makeFirm("A");
  b = await makeFirm("B");
  fakeS3().put("k-pdf", await blankPdf(2));
  signInAs(b.admin);
});

const row = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });

/** Lanza la acción como ADMIN de B y comprueba que la factura de A queda igual
 *  (fila, historial, auditoría, hijas y ficheros). */
async function expectRefused(id: string, act: () => Promise<{ error: unknown }>) {
  const before = await row(id);
  const keysBefore = fakeS3().keys();
  expect((await act()).error).toBe(NO_ACCESS);
  expect(await row(id)).toEqual(before);
  expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: id } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { invoiceId: id } })).toBe(0);
  expect(await prisma.invoice.count({ where: { splitFromId: id } })).toBe(0);
  expect(fakeS3().keys()).toEqual(keysBefore);
}

describe("el ADMIN de otra asesoría no toca una factura de A", () => {
  it("validar", async () => {
    const { id } = await makeInvoice(a.client);
    await expectRefused(id, async () => validate(reviewForm(id, (await row(id)).updatedAt, a.client)));
  });

  it("guardar", async () => {
    const { id } = await makeInvoice(a.client);
    await expectRefused(id, async () =>
      settleAction(saveInvoiceFields(null, reviewForm(id, (await row(id)).updatedAt, a.client, { invoiceNumber: "OTRO" }))));
  });

  it("rechazar", async () => {
    const { id } = await makeInvoice(a.client);
    await expectRefused(id, () => reject(id));
  });

  it("dividir el PDF", async () => {
    const { id } = await makeInvoice(a.client, { storageKey: "k-pdf" });
    const parts = [{ name: "a", startPage: 1, endPage: 1 }, { name: "b", startPage: 2, endPage: 2 }];
    await expectRefused(id, () => settleAction(splitPdfInvoice(id, parts, "all")));
  });

  it("dividir una imagen en recortes", async () => {
    const { id } = await makeInvoice(a.client, { storageKey: "k-pdf", fileType: "image/png" });
    const tickets = [{ name: "t1", dataUrl: PNG_DATA_URL }, { name: "t2", dataUrl: PNG_DATA_URL }];
    await expectRefused(id, () => settleAction(splitInvoice(id, tickets, "all")));
  });

  it("«Reabrir y validar» una rechazada", async () => {
    const { id } = await makeInvoice(a.client, { status: "REJECTED", rejectionReason: "Ilegible", rejectionCategory: "ILLEGIBLE" });
    await expectRefused(id, async () => validate(reviewForm(id, (await row(id)).updatedAt, a.client, { reopen: "1" })));
  });
});

describe("el archivo no cruza asesorías (rutas y lecturas nuevas)", () => {
  const getOriginal = (id: string, query = "") =>
    archiveOriginal(new NextRequest(`http://x/api/archive/invoices/${id}/original${query}`), { params: Promise.resolve({ id }) });

  it("el original de una factura de A, y su copia, dan 404 al admin y al gestor de B", async () => {
    const { id } = await makeInvoice(a.client, { storageKey: "k-pdf" });
    for (const user of [b.admin, b.worker]) {
      signInAs(user);
      expect((await getOriginal(id)).status).toBe(404);
      expect((await getOriginal(id, "?copia=1")).status).toBe(404);
    }
    signInAs(a.admin);
    expect((await getOriginal(id)).status).toBe(200);
  });

  it("buscar desde B el nº, el NIF, el importe, el nº de registro o el cliente de A no trae nada", async () => {
    const invoice = await makeInvoice(a.client, { status: "VALIDATED", invoiceNumber: "AISL-1", issuerCif: "B11111111", totalAmount: 987.65 });
    const series = await prisma.invoiceRegisterSeries.create({ data: { clientId: a.client.id, type: "PURCHASE", year: 2026, lastNumber: 1 } });
    await prisma.invoiceArchive.update({
      where: { invoiceId: invoice.id },
      data: { registerSeriesId: series.id, registerNumber: 1, registeredAt: new Date("2026-10-05T10:00:00Z") },
    });
    const scopeB = (await archiveScope({ user: b.admin }))!;
    // Un ámbito amañado con el cliente de A tampoco: la asesoría manda siempre.
    const forged = { firmId: b.firm.id, clientIds: [a.client.id, b.client.id] };
    for (const q of ["AISL-1", "B11111111", "987,65", "R-2026/1", a.client.name]) {
      expect(await searchArchive(scopeB, q)).toEqual([]);
      expect(await searchArchive(forged, q)).toEqual([]);
    }
    const scopeA = (await archiveScope({ user: a.admin }))!;
    expect((await searchArchive(scopeA, "AISL-1")).map((r) => r.invoiceId)).toEqual([invoice.id]);
  });

  it("las cifras, el archivo de un cliente, la ficha y las tandas de A no se ven desde B", async () => {
    const scopeB = (await archiveScope({ user: b.admin }))!;
    expect(scopeB.clientIds).toEqual([b.client.id]);
    const forged = await loadArchiveMetrics({ firmId: b.firm.id, clientIds: [a.client.id, b.client.id] });
    expect(forged.clients.map((c) => c.clientId)).toEqual([b.client.id]);
    expect(forged.totals.map((t) => t.invoices)).toEqual([2]);
    expect(await loadClientArchive({ firmId: b.firm.id, clientId: a.client.id })).toBeNull();
    expect(await loadArchiveInvoice(a.invoices.pending.id, b.firm.id)).toBeNull();
    expect(await canAccessArchiveInvoice({ user: b.admin }, a.invoices.pending.id)).toBe(false);
    const batch = await prisma.uploadBatch.create({
      data: { advisoryFirmId: a.firm.id, clientId: a.client.id, createdById: a.worker.id, fileCount: 1, periodYear: 2026 },
    });
    expect(await canAccessUploadBatch({ user: b.admin }, batch.id)).toBe(false);
    expect(await canAccessUploadBatch({ user: b.worker }, batch.id)).toBe(false);
  });

  it("el ZIP del ejercicio de un cliente de A y su original adjunto no se tocan desde B", async () => {
    const getZip = (query: string) =>
      archiveZip(new NextRequest(`http://x/api/archive/clients/${a.client.id}/zip${query}`), { params: Promise.resolve({ id: a.client.id }) });
    signInAs(b.admin);
    expect((await getZip("?ejercicio=2026")).status).toBe(404);
    expect((await getZip("?ejercicio=2026&check=1")).status).toBe(404);
    signInAs(b.worker);
    expect((await getZip("?ejercicio=2026")).status).toBe(403);

    const { id } = await makeInvoice(a.client, { storageKey: "k-pdf" });
    const keysBefore = fakeS3().keys();
    const documentsBefore = await prisma.document.count();
    const word = new Uint8Array(1024);
    word.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    word.set([..."WordDocument"].flatMap((ch) => [ch.charCodeAt(0), 0]), 512);
    for (const user of [b.admin, b.worker]) {
      signInAs(user);
      const form = new FormData();
      form.set("invoiceId", id);
      form.set("file", new File([word], "intruso.doc"));
      expect(await attachOriginalDocumentAction(form)).toEqual({ error: "No tienes acceso a estas facturas." });
      expect(await removeOriginalDocumentAction({ invoiceId: id })).toEqual({ error: "No tienes acceso a estas facturas." });
    }
    expect(fakeS3().keys()).toEqual(keysBefore);
    expect(await prisma.document.count()).toBe(documentsBefore);
    expect((await prisma.invoiceArchive.findUniqueOrThrow({ where: { invoiceId: id } })).originalDocumentId).toBeNull();
    expect(await prisma.auditLog.count({ where: { invoiceId: id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { field: "archiveExport" } })).toBe(0);
  });

  it("subir a un cliente de A desde B: 403, sin factura ni fichero", async () => {
    signInAs(b.admin);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(await blankPdf(1))], "intruso.pdf", { type: "application/pdf" }));
    form.set("clientId", a.client.id);
    form.set("periodType", "MONTHLY");
    form.set("periodMonth", "9");
    form.set("periodYear", "2026");
    form.set("type", "PURCHASE");
    const keysBefore = fakeS3().keys();
    const res = await upload(new Request("http://app.local/api/uploads", { method: "POST", body: form }));
    expect(res.status).toBe(403);
    expect(await prisma.invoice.count({ where: { filename: "intruso.pdf" } })).toBe(0);
    expect(fakeS3().keys()).toEqual(keysBefore);
  });
});
