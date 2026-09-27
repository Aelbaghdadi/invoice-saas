// Dividir (PR #4, F-056): se reserva la original antes de crear las hijas.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./helpers/db";
import { fakeS3 } from "./helpers/fakeS3";
import { makeFirm, makeInvoice, type FirmWorld } from "./helpers/factories";
import { blankPdf, PNG_DATA_URL, wait } from "./helpers/fixtures";
import { holdLock } from "./helpers/locks";
import { signInAs } from "./helpers/session";
import { splitInvoice, splitPdfInvoice } from "@/app/dashboard/worker/review/[id]/actions";
import { reviewTargetWhere } from "@/lib/invoiceStatuses";

let w: FirmWorld;
const parts = [{ name: "a", startPage: 1, endPage: 1 }, { name: "b", startPage: 2, endPage: 2 }];

beforeEach(async () => {
  w = await makeFirm("A");
  fakeS3().put("k-pdf", await blankPdf(2));
  await makeInvoice(w.client, { id: "inv1", storageKey: "k-pdf" });
  signInAs(w.worker);
});

// { error } o redireccion (exito).
const settle = (p: Promise<{ error?: string } | void>) => p.then(
  (r) => ({ error: r?.error ?? null }),
  (e) => (e?.message === "NEXT_REDIRECT" ? { error: null } : Promise.reject(e)),
);
const run = () => settle(splitPdfInvoice("inv1", parts, "all"));
const runImage = () => settle(splitInvoice("inv1", [{ name: "t1", dataUrl: PNG_DATA_URL }, { name: "t2", dataUrl: PNG_DATA_URL }], "all"));
const children = () => prisma.invoice.count({ where: { splitFromId: "inv1" } });
const status = async () => (await prisma.invoice.findUniqueOrThrow({ where: { id: "inv1" } })).status;
const splitKeys = () => fakeS3().keys().filter((k) => k.includes("-split-"));

describe("dividir reserva antes la original", () => {
  it("camino normal: original SPLIT_SOURCE, dos hijas, historial y auditoría", async () => {
    expect(await run()).toEqual({ error: null });
    expect(await status()).toBe("SPLIT_SOURCE");
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: "inv1", toStatus: "SPLIT_SOURCE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { invoiceId: "inv1", newValue: "SPLIT_SOURCE" } })).toBe(1);
  });

  it("dos divisiones de PDF a la vez: solo una crea hijas y la otra no deja ficheros", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    const errors = [a.error, b.error].filter(Boolean);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/dividió en otras|ha cambiado/);
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: "inv1", toStatus: "SPLIT_SOURCE" } })).toBe(1);
  });

  it("dos divisiones de recortes de imagen a la vez: solo una crea hijas", async () => {
    await prisma.invoice.update({ where: { id: "inv1" }, data: { fileType: "image/png" } });
    const [a, b] = await Promise.all([runImage(), runImage()]);
    expect([a.error, b.error].filter(Boolean)).toHaveLength(1);
    expect(await children()).toBe(2);
    expect(splitKeys()).toHaveLength(2);
  });

  it("exportada: no se divide y no quedan ficheros", async () => {
    await prisma.exportBatch.create({ data: { id: "b1", format: "a3excel", invoiceCount: 1, userId: w.admin.id } });
    await prisma.invoice.update({ where: { id: "inv1" }, data: { status: "VALIDATED", exportBatchId: "b1" } });
    expect(String((await run()).error)).toMatch(/exportó a A3/);
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });

  it("rechazada entre la comprobación y la reserva: no reserva, sin hijas ni ficheros", async () => {
    const lock = await holdLock(`SELECT 1 FROM "Invoice" WHERE id = 'inv1' FOR UPDATE`);
    const pending = run();
    await wait(1500); // comprobacion previa hecha, ficheros subidos, reserva esperando
    expect(splitKeys()).toHaveLength(2);
    await lock.release(`UPDATE "Invoice" SET status = 'REJECTED' WHERE id = 'inv1'`);
    const r = await pending;
    expect(String(r.error)).toMatch(/rechazada/);
    expect(await status()).toBe("REJECTED");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });

  it("validada mientras se preparaban las partes: no reserva con un estado de origen viejo", async () => {
    fakeS3().setMode("slow:1500");
    const pending = run();
    await wait(500); // comprobacion previa hecha, descargando el PDF
    await prisma.invoice.update({ where: { id: "inv1" }, data: { status: "VALIDATED" } });
    const r = await pending;
    expect(String(r.error)).toMatch(/ha cambiado/);
    expect(await status()).toBe("VALIDATED");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
    expect(await prisma.invoiceStatusHistory.count({ where: { invoiceId: "inv1" } })).toBe(0);
  });

  it("una original VALIDATED que ya tiene hijas no se vuelve a dividir (también en la reserva)", async () => {
    await prisma.invoice.update({ where: { id: "inv1" }, data: { status: "VALIDATED" } });
    await makeInvoice(w.client, { status: "VALIDATED", splitFromId: "inv1" });
    expect((await run()).error).toBe("Esta factura ya se dividió: trabaja con las facturas que salieron de ella.");
    expect(await children()).toBe(1);
    expect(splitKeys()).toHaveLength(0);
    const r = await prisma.invoice.updateMany({ where: { id: "inv1", ...reviewTargetWhere("split") }, data: { status: "SPLIT_SOURCE" } });
    expect(r.count).toBe(0);
  });

  it("las hijas heredan typeUnconfirmed y periodType", async () => {
    await prisma.invoice.update({ where: { id: "inv1" }, data: { typeUnconfirmed: true, periodType: "QUARTERLY", periodMonth: 7 } });
    expect((await run()).error).toBeNull();
    const kids = await prisma.invoice.findMany({ where: { splitFromId: "inv1" } });
    expect(kids.map((k) => [k.typeUnconfirmed, k.periodType, k.periodMonth])).toEqual([[true, "QUARTERLY", 7], [true, "QUARTERLY", 7]]);
  });

  it.each([
    ["dañado", async () => Buffer.from("esto no es un pdf")],
    ["sin /Pages", async () => Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")],
    ["sin páginas", async () => blankPdf(0)],
  ])("PDF %s: { error } y no sube nada", async (_label, make) => {
    fakeS3().put("k-pdf", await make());
    expect((await run()).error).toBe("No se ha podido leer el PDF para dividirlo (¿está protegido o dañado?).");
    expect(await status()).toBe("PENDING_REVIEW");
    expect(splitKeys()).toHaveLength(0);
  });

  it("el gestor de otra asesoría no puede dividirla", async () => {
    const b = await makeFirm("B");
    signInAs(b.worker);
    expect((await run()).error).toBeTruthy();
    expect(await status()).toBe("PENDING_REVIEW");
    expect(await children()).toBe(0);
    expect(splitKeys()).toHaveLength(0);
  });
});
