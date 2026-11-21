// «Reabrir y validar» frente a la resubida del cliente (PR #4, revision 2).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, PNG_DATA_URL, utcMinutesAgoSql } from "./helpers/fixtures";
import { holdLock, sessionsWaitingForLock } from "./helpers/locks";
import { inFlight } from "./helpers/inflight";
import { signInAs } from "./helpers/session";
import { reviewForm, validate } from "./helpers/reviewForm";
import { reuploadInvoiceAction } from "@/app/dashboard/client/invoices/reupload-actions";

let w: FirmWorld;
let id: string;
const A = () => prisma.invoice.findUniqueOrThrow({ where: { id } });
const reuploadKeys = () => fakeS3().keys().filter((k) => k.includes("reupload-"));

beforeEach(async () => {
  w = await makeFirm("A");
  ({ id } = await makeInvoice(w.client, { status: "REJECTED", rejectionReason: "Ilegible", fileHash: "otro" }));
});

async function reupload() {
  signInAs(w.clientUser);
  const fd = new FormData();
  fd.set("rejectedId", id);
  fd.set("file", new File([new Uint8Array(await blankPdf(1))], "corregida.pdf", { type: "application/pdf" }));
  return reuploadInvoiceAction(null, fd);
}

describe("resubida del cliente contra «Reabrir y validar»", () => {
  it("camino normal: crea la sustituta", async () => {
    expect(await reupload()).toEqual({ success: true });
    expect(await prisma.invoice.count({ where: { replacesId: id } })).toBe(1);
    expect(reuploadKeys()).toHaveLength(1);
  });

  it("el gestor reabre y valida mientras el cliente sube: no se crea la sustituta y se borra el fichero", async () => {
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = $1 FOR UPDATE`, id);
    const pending = inFlight(reupload());
    // Fichero subido y la transaccion de la resubida esperando la fila.
    await vi.waitFor(async () => {
      expect(reuploadKeys()).toHaveLength(1);
      expect(await sessionsWaitingForLock()).toBe(1);
    }, { timeout: 10_000 });
    await lock.release(`UPDATE "Invoice" SET status = 'VALIDATED', "rejectionReason" = NULL, "updatedAt" = ${utcMinutesAgoSql(0)} WHERE id = $1`);
    expect(await pending).toEqual({ error: "Esta factura ya no está rechazada. Recarga la página." });
    expect(await prisma.invoice.count({ where: { replacesId: id } })).toBe(0);
    expect(reuploadKeys()).toHaveLength(0);
  });

  it("la resubida llega entera mientras el gestor reabre: la reapertura no valida la rechazada", async () => {
    signInAs(w.worker);
    const leido = (await A()).updatedAt;
    // La reapertura se para al leer los cierres de periodo, despues de sus
    // comprobaciones previas (aun no hay sustituta) y antes de escribir.
    const lock = await holdLock(`LOCK TABLE "PeriodClosure" IN ACCESS EXCLUSIVE MODE`);
    const reopening = inFlight(validate(reviewForm(id, leido, w.client, { reopen: "1" })));
    await vi.waitFor(async () => expect(await sessionsWaitingForLock()).toBe(1), { timeout: 10_000 });
    expect(await reupload()).toEqual({ success: true });
    await lock.release();
    expect((await reopening).error).toBe("El cliente ya subió una versión corregida de esta factura: valida esa en su lugar.");
    expect((await A()).status).toBe("REJECTED");
    expect(await prisma.invoice.count({ where: { replacesId: id } })).toBe(1);
  });

  it("el cliente de otra asesoría no puede resubirla", async () => {
    const b = await makeFirm("B");
    signInAs(b.clientUser);
    const fd = new FormData();
    fd.set("rejectedId", id);
    fd.set("file", new File([new Uint8Array(await blankPdf(1))], "x.pdf", { type: "application/pdf" }));
    expect((await reuploadInvoiceAction(null, fd))?.error).toBe("Factura no encontrada.");
    expect(await prisma.invoice.count({ where: { replacesId: id } })).toBe(0);
    expect(reuploadKeys()).toHaveLength(0);
  });
});

describe("la resubida en el archivo (paso 5)", () => {
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const replacement = () => prisma.invoice.findFirstOrThrow({ where: { replacesId: id }, include: { archive: true, document: true } });

  it("tiene su fila: la guarda el cliente, la llegada es su alta y el PDF espera al análisis", async () => {
    expect(await reupload()).toEqual({ success: true });
    const r = await replacement();
    expect(r.archive).toMatchObject({
      paperHeldByClient: true,
      receivedAt: r.createdAt,
      originalMedium: null,
      originalMediumSource: null,
      uploadBatchId: null,
      splitPart: 0,
    });
  });

  it("una foto queda «Por confirmar», y la guarda el cliente", async () => {
    signInAs(w.clientUser);
    const png = Buffer.from(PNG_DATA_URL.split(",")[1], "base64");
    const fd = new FormData();
    fd.set("rejectedId", id);
    fd.set("file", new File([new Uint8Array(png)], "foto.png", { type: "image/png" }));
    expect(await reuploadInvoiceAction(null, fd)).toEqual({ success: true });
    expect((await replacement()).archive).toMatchObject({
      paperHeldByClient: true,
      originalMedium: null,
      originalMediumSource: "AUTO",
      originalMediumReason: "image_unconfirmed",
    });
  });

  it("la clave es única: cliente, periodo, instante, UUID y la etiqueta reupload", async () => {
    expect(await reupload()).toEqual({ success: true });
    const r = await replacement();
    expect(r.storageKey).toMatch(new RegExp(`^${w.client.id}/2026-09/\\d+-${UUID}-reupload-corregida\\.pdf$`));
    expect(r.document?.storageKey).toBe(r.storageKey);
    expect(reuploadKeys()).toEqual([r.storageKey]);
  });
});
