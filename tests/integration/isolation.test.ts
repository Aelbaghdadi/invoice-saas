// Aislamiento entre asesorías en la pantalla de revisión: el ADMIN de otra
// asesoría, conociendo el id, no puede tocar una factura de A.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, PNG_DATA_URL } from "./helpers/fixtures";
import { signInAs } from "./helpers/session";
import { reject, reviewForm, settleAction, validate } from "./helpers/reviewForm";
import {
  saveInvoiceFields, splitInvoice, splitPdfInvoice,
} from "@/app/dashboard/worker/review/[id]/actions";

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
