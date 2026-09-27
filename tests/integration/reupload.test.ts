// «Reabrir y validar» frente a la resubida del cliente (PR #4, revision 2).
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, utcMinutesAgoSql, wait } from "./helpers/fixtures";
import { holdLock } from "./helpers/locks";
import { signInAs } from "./helpers/session";
import { reviewForm, validate } from "./helpers/reviewForm";
import { reuploadInvoiceAction } from "@/app/dashboard/client/invoices/reupload-actions";

let w: FirmWorld;
const A = () => prisma.invoice.findUniqueOrThrow({ where: { id: "A" } });
const reuploadKeys = () => fakeS3().keys().filter((k) => k.includes("reupload-"));

beforeEach(async () => {
  w = await makeFirm("A");
  await makeInvoice(w.client, { id: "A", status: "REJECTED", rejectionReason: "Ilegible", fileHash: "otro" });
});

async function reupload() {
  signInAs(w.clientUser);
  const fd = new FormData();
  fd.set("rejectedId", "A");
  fd.set("file", new File([new Uint8Array(await blankPdf(1))], "corregida.pdf", { type: "application/pdf" }));
  return reuploadInvoiceAction(null, fd);
}

describe("resubida del cliente contra «Reabrir y validar»", () => {
  it("camino normal: crea la sustituta", async () => {
    expect(await reupload()).toEqual({ success: true });
    expect(await prisma.invoice.count({ where: { replacesId: "A" } })).toBe(1);
    expect(reuploadKeys()).toHaveLength(1);
  });

  it("el gestor reabre y valida mientras el cliente sube: no se crea la sustituta y se borra el fichero", async () => {
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = 'A' FOR UPDATE`);
    const pending = reupload();
    await wait(1500); // fichero subido; la transaccion de la resubida espera la fila
    expect(reuploadKeys()).toHaveLength(1);
    await lock.release(`UPDATE "Invoice" SET status = 'VALIDATED', "rejectionReason" = NULL, "updatedAt" = ${utcMinutesAgoSql(0)} WHERE id = 'A'`);
    expect(await pending).toEqual({ error: "Esta factura ya no está rechazada. Recarga la página." });
    expect(await prisma.invoice.count({ where: { replacesId: "A" } })).toBe(0);
    expect(reuploadKeys()).toHaveLength(0);
  });

  it("la resubida llega antes: la reapertura con el updatedAt viejo no valida la rechazada", async () => {
    const leido = (await A()).updatedAt;
    expect(await reupload()).toEqual({ success: true });
    signInAs(w.worker);
    const r = await validate(reviewForm("A", leido, w.client, { reopen: "1" }));
    expect(r.error).toBe("El cliente ya subió una versión corregida de esta factura: valida esa en su lugar.");
    expect((await A()).status).toBe("REJECTED");
  });

  it("el cliente de otra asesoría no puede resubirla", async () => {
    const b = await makeFirm("B");
    signInAs(b.clientUser);
    const fd = new FormData();
    fd.set("rejectedId", "A");
    fd.set("file", new File([new Uint8Array(await blankPdf(1))], "x.pdf", { type: "application/pdf" }));
    expect((await reuploadInvoiceAction(null, fd))?.error).toBeTruthy();
    expect(await prisma.invoice.count({ where: { replacesId: "A" } })).toBe(0);
    expect(reuploadKeys()).toHaveLength(0);
  });
});
